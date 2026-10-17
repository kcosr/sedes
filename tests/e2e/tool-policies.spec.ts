import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { configurationSnapshotSchema } from "../../src/shared/protocol/configuration-admin.js";
import { normalizedApplicationSnapshotSchema } from "../../src/shared/protocol/application.js";
import { normalizedThreadSnapshotSchema } from "../../src/shared/protocol/conversation.js";
import { savedAgentOptionsResultSchema, type NormalizedAgentConfigurationOverrides } from "../../src/shared/protocol/saved-agents.js";
import { capture, expectNoPageOverflow, openSedesWorkspace, openSettingsPage, returnFromSettings, repositoryLabel, selectProjectIfNeeded, selectRadixOption } from "./helpers";

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
  const executionTarget = application.executionTargets.find(item => item.available && item.label.text === target.label && item.environmentId === target.executionEnvironmentId && item.backend.brand === "pi");
  expect(executionTarget).toBeDefined();
  if (!executionTarget) throw new Error("policy_e2e_execution_target_unavailable");

  await openSettingsPage(page, "tool_policies");
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

  await openSettingsPage(page, "tool_policies");
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

  await openSettingsPage(page, "environments");
  await page.getByRole("link", { name: "Local", exact: true }).click();
  const environmentPolicy = page.getByRole("region", { name: "Sedes tool policy", exact: true });
  await expect(environmentPolicy.getByText(`Inherited from account defaults · Everyday · revision ${everyday.revision}`, { exact: true })).toBeVisible();
  await environmentPolicy.getByRole("combobox", { name: "Tool policy", exact: true }).selectOption("disabled");
  const environmentSaved = page.waitForResponse(response => response.request().method() === "PUT" && response.url().endsWith("/api/tool-policy-selections") && response.ok());
  await environmentPolicy.getByRole("button", { name: "Save default", exact: true }).click();
  await environmentSaved;
  expect(await resolve()).toMatchObject({ source: "environment", enabled: false, enabledToolIds: [] });

  await openSettingsPage(page, "backends");
  await page.getByRole("link", { name: target.label, exact: true }).click();
  const backendPolicy = page.getByRole("region", { name: "Sedes tool policy", exact: true });
  await expect(backendPolicy.getByText("Inherited from environment defaults", { exact: true })).toBeVisible();
  await backendPolicy.getByRole("combobox", { name: "Tool policy", exact: true }).selectOption(reviewer.id);
  const backendSaved = page.waitForResponse(response => response.request().method() === "PUT" && response.url().endsWith("/api/tool-policy-selections") && response.ok());
  await backendPolicy.getByRole("button", { name: "Save default", exact: true }).click();
  await backendSaved;
  expect(await resolve()).toMatchObject({ source: "backend", enabledToolIds: ["thread.list"], resourceScope: { allowOtherEnvironments: false, allowOtherProjects: false } });
  await capture(page, testInfo, "tool-policy-backend-default.png");

  await returnFromSettings(page);
  await page.getByTestId("desktop-sidebar").getByTestId("new-thread-trigger").click();
  await selectProjectIfNeeded(page, repositoryLabel);
  await selectRadixOption(page, page.getByRole("combobox", { name: "Target", exact: true }), target.label);
  const creation = page.getByRole("dialog", { name: "New thread", exact: true });
  await expect(creation.getByText(`Inherited from backend settings · Reviewer · revision ${reviewer.revision}`, { exact: true })).toBeVisible();
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
  // An explicit Custom choice replaces the inherited backend policy and exposes presentation.
  await page.getByTestId("desktop-sidebar").getByTestId("new-thread-trigger").click();
  await selectProjectIfNeeded(page, repositoryLabel);
  await selectRadixOption(page, page.getByRole("combobox", { name: "Target", exact: true }), target.label);
  await creation.getByRole("combobox", { name: "Sedes tool policy", exact: true }).selectOption(everyday.id);
  await creation.getByRole("combobox", { name: "Tool presentation", exact: true }).selectOption("cli:individual");
  await creation.getByRole("region", { name: "Sedes tools", exact: true }).scrollIntoViewIfNeeded();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "new-thread-tools-desktop.png");
  const customCreated = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/threads") && response.status() === 201);
  await creation.getByRole("button", { name: "Create thread", exact: true }).click();
  const customResponse = await customCreated;
  expect(customResponse.request().postDataJSON()).toMatchObject({ toolPolicySelection: { kind: "policy_set", policySetId: everyday.id }, toolPresentation: { surface: "cli", mode: "individual" }, configuration: { kind: "custom" } });
  const customThreadId = (await customResponse.json()).threadId;
  await expect(page).toHaveURL(`/threads/${customThreadId}`);
  const readCustomSnapshot = async () => {
    const response = await page.request.get(`/api/threads/${customThreadId}?activityDetail=full`);
    expect(response.ok()).toBe(true);
    return normalizedThreadSnapshotSchema.parse(await response.json());
  };
  const customSnapshot = await readCustomSnapshot();
  expect(customSnapshot.agentTools.groups.flatMap(group => group.tools.filter(tool => tool.enabled).map(tool => tool.id)).sort()).toEqual(["agent.context", "thread.list"]);
  expect(customSnapshot.agentTools.policySet).toMatchObject({ id: everyday.id, name: "Everyday", revision: everyday.revision });
  expect(initial.agentTools.resourceScope).toEqual({ allowOtherEnvironments: false, allowOtherProjects: false });
  expect(initial.agentTools.groups.flatMap(group => group.tools.filter(tool => tool.enabled).map(tool => tool.id))).toEqual(["thread.list"]);

  // Applying a reusable policy copies into the existing thread's editable draft.
  // Presentation remains independent; the applied-set name follows the draft.
  await page.getByRole("button", { name: "Thread actions", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Agent tools…/ }).click();
  const toolsDialog = page.getByRole("dialog", { name: "Agent tools", exact: true });
  const policyChooser = toolsDialog.getByRole("combobox", { name: "Policy set", exact: true });
  await expect(policyChooser).toBeEnabled();
  await expect(policyChooser).toHaveValue(everyday.id);
  await expect(toolsDialog.getByText(/Original policy:/)).toHaveCount(0);
  await policyChooser.selectOption(reviewer.id);
  await policyChooser.scrollIntoViewIfNeeded();
  await expect(policyChooser).toBeVisible();
  await expect(policyChooser).toBeInViewport();
  await expect(toolsDialog.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "thread-apply-policy-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await policyChooser.scrollIntoViewIfNeeded();
  await expect(policyChooser).toBeVisible();
  await expect(policyChooser).toBeInViewport();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "thread-apply-policy-mobile.png");
  await page.setViewportSize({ width: 1440, height: 1000 });
  const applied = page.waitForResponse(response => response.request().method() === "GET" && response.url().endsWith(`/api/tool-policies/${reviewer.id}`) && response.ok());
  await toolsDialog.getByRole("button", { name: "Apply", exact: true }).click();
  await applied;
  const appliedStatus = toolsDialog.getByText(/^Loaded Reviewer/);
  await expect(appliedStatus).toBeVisible();
  await toolsDialog.locator('[data-slot="dialog-body"]').evaluate(body => body.scrollTo({ top: 0 }));
  await expect(appliedStatus).toBeInViewport();
  await expect(policyChooser).toBeVisible();
  await expect(policyChooser).toBeInViewport();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "thread-applied-policy-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await toolsDialog.locator('[data-slot="dialog-body"]').evaluate(body => body.scrollTo({ top: 0 }));
  await expect(appliedStatus).toBeVisible();
  await expect(appliedStatus).toBeInViewport();
  await expect(policyChooser).toBeVisible();
  await expect(policyChooser).toBeInViewport();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "thread-applied-policy-mobile.png");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(toolsDialog.getByRole("switch", { name: "Enable agent tools", exact: true })).toBeChecked();
  await expect(toolsDialog.getByRole("switch", { name: "Allow other environments", exact: true })).not.toBeChecked();
  await expect(toolsDialog.getByRole("switch", { name: "Allow other projects", exact: true })).not.toBeChecked();
  await expect(toolsDialog.getByRole("combobox", { name: "Agent tool surface", exact: true })).toContainText("Sedes CLI");
  await expect(toolsDialog.getByRole("combobox", { name: "Agent tool presentation", exact: true })).toContainText("Individual");
  await toolsDialog.getByRole("button", { name: "Context", exact: true }).click();
  await expect(toolsDialog.getByRole("checkbox", { name: "Agent context", exact: true })).not.toBeChecked();
  await toolsDialog.getByRole("button", { name: "Threads", exact: true }).click();
  await expect(toolsDialog.getByRole("checkbox", { name: "List threads", exact: true })).toBeChecked();
  expect((await readCustomSnapshot()).agentTools).toEqual(customSnapshot.agentTools);

  const savePolicyDraft = async () => {
    const saved = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith(`/api/threads/${customThreadId}/operations`) && response.ok() && response.request().postDataJSON()?.kind === "set_agent_tool_policy");
    await toolsDialog.getByRole("button", { name: "Save", exact: true }).click();
    const response = await saved;
    await expect(toolsDialog).toBeHidden();
    return response.request().postDataJSON();
  };
  const reopenPolicy = async () => {
    await page.getByRole("button", { name: "Thread actions", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Agent tools…/ }).click();
    await expect(policyChooser).toBeEnabled();
  };
  // Saving an applied set records its identity even though the tools are a snapshot.
  expect(await savePolicyDraft()).toMatchObject({ policySet: { id: reviewer.id, revision: reviewer.revision } });
  expect((await readCustomSnapshot()).agentTools.policySet).toEqual({ id: reviewer.id, name: "Reviewer", revision: reviewer.revision });
  await reopenPolicy();
  await expect(policyChooser).toHaveValue(reviewer.id);
  // Presentation belongs to the thread, so changing it keeps the named set.
  await selectRadixOption(page, toolsDialog.getByRole("combobox", { name: "Agent tool presentation", exact: true }), /Progressive discovery/);
  await expect(policyChooser).toHaveValue(reviewer.id);
  expect(await savePolicyDraft()).toMatchObject({ presentation: { surface: "cli", mode: "progressive" }, policySet: { id: reviewer.id, revision: reviewer.revision } });
  expect((await readCustomSnapshot()).agentTools.policySet).toEqual({ id: reviewer.id, name: "Reviewer", revision: reviewer.revision });
  await reopenPolicy();
  await expect(policyChooser).toHaveValue(reviewer.id);

  await toolsDialog.getByRole("button", { name: "Context", exact: true }).click();
  await toolsDialog.getByRole("checkbox", { name: "Agent context", exact: true }).check();
  await expect(policyChooser).toHaveValue("");
  await expect(policyChooser.locator("option:checked")).toHaveText("Custom");
  await toolsDialog.getByRole("switch", { name: "Allow other projects", exact: true }).check();
  const customized = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith(`/api/threads/${customThreadId}/operations`) && response.ok() && response.request().postDataJSON()?.kind === "set_agent_tool_policy");
  await toolsDialog.getByRole("button", { name: "Save", exact: true }).click();
  const customizedResponse = await customized;
  expect(customizedResponse.request().postDataJSON()).toMatchObject({
    kind: "set_agent_tool_policy", enabled: true, enabledToolIds: ["agent.context", "thread.list"],
    resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
    presentation: { surface: "cli", mode: "progressive" }, policySet: null,
  });
  await expect(toolsDialog).toBeHidden();
  const customizedSnapshot = await readCustomSnapshot();
  const assertCustomizedPolicy = (snapshot: typeof customizedSnapshot) => {
    expect(snapshot.agentTools).toMatchObject({ enabled: true, presentation: { surface: "cli", mode: "progressive" }, resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true } });
    expect(snapshot.agentTools.policySet).toBeNull();
    expect(snapshot.agentTools.groups.flatMap(group => group.tools.filter(tool => tool.enabled).map(tool => tool.id)).sort()).toEqual(["agent.context", "thread.list"]);
  };
  assertCustomizedPolicy(customizedSnapshot);
  await reopenPolicy();
  await expect(policyChooser).toHaveValue("");
  await expect(policyChooser.locator("option:checked")).toHaveText("Custom");
  await toolsDialog.getByRole("button", { name: "Cancel", exact: true }).click();

  await openSettingsPage(page, "tool_policies");
  await page.getByRole("link", { name: "Reviewer", exact: true }).click();
  await page.getByRole("switch", { name: "Allow other environments", exact: true }).check();
  await page.getByRole("switch", { name: "Allow other projects", exact: true }).check();
  const policyUpdated = page.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(`/api/tool-policies/${reviewer.id}`) && response.ok());
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await policyUpdated;
  expect(await resolve()).toMatchObject({ source: "backend", resourceScope: { allowOtherEnvironments: true, allowOtherProjects: true } });
  expect((await snapshot()).agentTools.resourceScope).toEqual(initial.agentTools.resourceScope);
  expect((await snapshot()).agentTools.policySet).toEqual(initial.agentTools.policySet);
  assertCustomizedPolicy(await readCustomSnapshot());
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoPageOverflow(page);
  await expect(page.getByRole("region", { name: "Policy sets", exact: true })).toBeHidden();
  await capture(page, testInfo, "tool-policy-editor-mobile.png");

  const workspace = application.workspaces.find(item => item.environmentId === target.executionEnvironmentId && item.available && item.label.text === repositoryLabel);
  expect(workspace).toBeDefined();
  if (!workspace) throw new Error("policy_e2e_workspace_unavailable");
  const authoringContext = { workspaceId: workspace.id, targetId: executionTarget.id };
  const agentOptions = async (overrides: NormalizedAgentConfigurationOverrides) => {
    const response = await page.request.post("/api/agents/options", { headers: { "X-CSRF-Token": token }, data: { ...authoringContext, overrides } });
    expect(response.ok(), await response.text()).toBe(true);
    const result = savedAgentOptionsResultSchema.parse(await response.json());
    expect(result.kind).toBe("configuration");
    if (result.kind !== "configuration") throw new Error("policy_e2e_agent_configuration_unavailable");
    return result.configuration;
  };
  // A fresh target has no saved model preference. Author a complete Agent from
  // its advertised choices, then verify policy repair independently of defaults.
  const modelOptions = await agentOptions([]);
  const model = modelOptions.fields.find(field => field.id === "model")?.options.find(option => option.available);
  expect(model).toBeDefined();
  if (!model) throw new Error("policy_e2e_model_unavailable");
  const backendOverrides = [{ id: "model", value: model.value }];
  const configuredOptions = await agentOptions(backendOverrides);
  const thinking = configuredOptions.fields.find(field => field.id === "thinking_level")?.options.find(option => option.available);
  expect(thinking).toBeDefined();
  if (!thinking) throw new Error("policy_e2e_thinking_level_unavailable");
  backendOverrides.push({ id: "thinking_level", value: thinking.value });
  const agentResponse = await page.request.post("/api/agents", { headers: { "X-CSRF-Token": token }, data: {
    name: "Policy review Agent", authoringContext,
    backendOverrides, toolPolicySelection: { kind: "policy_set", policySetId: reviewer.id },
  } });
  expect(agentResponse.status(), await agentResponse.text()).toBe(201);

  await page.getByRole("button", { name: "Delete policy set…", exact: true }).click();
  const deletion = page.getByRole("dialog", { name: "Delete Reviewer?", exact: true });
  await expect(deletion).toContainText("Needs attention");
  const policyDeleted = page.waitForResponse(response => response.request().method() === "DELETE" && response.url().endsWith(`/api/tool-policies/${reviewer.id}`) && response.ok());
  await deletion.getByRole("button", { name: "Delete policy set", exact: true }).click();
  await policyDeleted;
  assertCustomizedPolicy(await readCustomSnapshot());
  expect((await snapshot()).agentTools.policySet).toEqual(initial.agentTools.policySet);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await returnFromSettings(page);
  // This deliberately exercises failed previews, without allowing unrelated browser failures.
  browserDiagnostics.allowedConsoleErrors.push(/^Failed to load resource: the server responded with a status of 404/);
  await page.getByTestId("desktop-sidebar").getByTestId("new-thread-trigger").click();
  await selectProjectIfNeeded(page, repositoryLabel);
  await selectRadixOption(page, page.getByRole("combobox", { name: "Target", exact: true }), target.label);
  await expect(creation.getByText(/Needs attention: the backend policy set was deleted/)).toBeVisible();
  await expect(creation.getByRole("button", { name: "Create thread", exact: true })).toBeDisabled();
  const isAgentResolution = (response: import("@playwright/test").Response) =>
    response.request().method() === "POST" && /\/api\/agents\/[^/]+\/resolve$/.test(response.url());
  const missingAgentResolved = page.waitForResponse(response => isAgentResolution(response) && response.request().postDataJSON()?.toolPolicySelection?.kind === "inherit");
  await selectRadixOption(page, creation.getByRole("combobox", { name: "Agent", exact: true }), /Policy review Agent/);
  await missingAgentResolved;
  await expect(creation.getByText(/Needs attention: the Agent policy set was deleted/)).toHaveCount(1);
  await expect(creation.getByRole("button", { name: "Create thread", exact: true })).toBeDisabled();
  const repairedAgentResolved = page.waitForResponse(response => isAgentResolution(response) && response.ok() && response.request().postDataJSON()?.toolPolicySelection?.policySetId === everyday.id);
  await creation.getByRole("combobox", { name: "Sedes tool policy", exact: true }).selectOption(everyday.id);
  await repairedAgentResolved;
  const presentationResolved = page.waitForResponse(response => isAgentResolution(response) && response.ok() && response.request().postDataJSON()?.toolPresentation?.surface === "native" && response.request().postDataJSON()?.toolPresentation?.mode === "individual");
  await creation.getByRole("combobox", { name: "Tool presentation", exact: true }).selectOption("native:individual");
  await presentationResolved;
  await expect(creation.getByRole("button", { name: "Create thread", exact: true })).toBeEnabled();
  const agentThreadCreated = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/threads") && response.status() === 201);
  await creation.getByRole("button", { name: "Create thread", exact: true }).click();
  const agentCreatedResponse = await agentThreadCreated;
  expect(agentCreatedResponse.request().postDataJSON()).toMatchObject({ toolPolicySelection: { kind: "policy_set", policySetId: everyday.id }, toolPresentation: { surface: "native", mode: "individual" }, configuration: { kind: "saved_agent" } });
  const agentThreadId = (await agentCreatedResponse.json()).threadId;
  const agentSnapshot = normalizedThreadSnapshotSchema.parse(await (await page.request.get(`/api/threads/${agentThreadId}?activityDetail=full`)).json());
  expect(agentSnapshot.agentTools.policySet).toMatchObject({ id: everyday.id });
  expect(agentSnapshot.agentTools.groups.flatMap(group => group.tools.filter(tool => tool.enabled).map(tool => tool.id)).sort()).toEqual(["agent.context", "thread.list"]);
  await openSettingsPage(page, "backends");
  await page.getByRole("link", { name: target.label, exact: true }).click();
  await expect(backendPolicy.getByText(/Needs attention: this policy set was deleted/)).toBeVisible();
  await backendPolicy.getByRole("combobox", { name: "Tool policy", exact: true }).selectOption("disabled");
  const repaired = page.waitForResponse(response => response.request().method() === "PUT" && response.url().endsWith("/api/tool-policy-selections") && response.ok());
  await backendPolicy.getByRole("button", { name: "Save default", exact: true }).click();
  await repaired;
  expect(await resolve()).toMatchObject({ source: "backend", enabled: false, enabledToolIds: [] });
  expect((await snapshot()).agentTools.resourceScope).toEqual(initial.agentTools.resourceScope);
  // Only the deliberate missing-reference previews may report 404; no unrelated failure is allowed.
  expect(browserDiagnostics.allowNetworkFailures).toBe(false);
});
