import type { Locator, Page } from "@playwright/test";
import {
  normalizedApplicationSessionSchema,
  normalizedApplicationSnapshotSchema,
  savedAgentMutationResultSchema,
} from "../../src/shared/index.js";
import { expect, test } from "./fixtures";
import {
  capture,
  expectNoPageOverflow,
  openSedesWorkspace,
  repositoryLabel,
  selectProjectIfNeeded,
  selectRadixOption,
} from "./helpers";

async function applicationSession(page: Page) {
  const response = await page.request.get("/api/application/session");
  expect(response.ok()).toBe(true);
  return normalizedApplicationSessionSchema.parse(await response.json());
}

async function applicationSnapshot(page: Page) {
  const response = await page.request.get("/api/application/snapshot");
  expect(response.ok()).toBe(true);
  return normalizedApplicationSnapshotSchema.parse(await response.json());
}

async function createAgent(page: Page, name: string) {
  await page.goto("/agents/new");
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await selectProjectIfNeeded(page, repositoryLabel);
  await selectRadixOption(
    page,
    page.getByRole("combobox", { name: "Configure using" }),
    "Pi SDK",
  );
  await page.getByRole("checkbox", { name: "Override Model" }).click();
  await page.getByRole("checkbox", { name: "Override Thinking" }).click();
  await selectRadixOption(
    page,
    page.getByRole("combobox", { name: "Thinking" }),
    /^High$/u,
  );
  await page.getByRole("checkbox", { name: "Override Tool access" }).click();
  await selectRadixOption(
    page,
    page.getByRole("combobox", { name: "Tool access" }),
    "Ask before changes",
  );
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/agents") &&
      response.status() === 201,
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  return savedAgentMutationResultSchema.parse(await (await created).json())
    .agent;
}

async function deleteAgent(page: Page, agentId: string, revision: number) {
  const current = await applicationSession(page);
  const response = await page.request.delete(`/api/agents/${agentId}`, {
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": current.csrfToken,
    },
    data: { expectedRevision: revision },
  });
  expect(response.status()).toBe(200);
}

async function chooseAgent(page: Page, name: string): Promise<void> {
  const picker = page.getByRole("combobox", { name: "Agent", exact: true });
  await picker.click();
  await page.getByRole("option", { name: new RegExp(name) }).click();
}

async function chooseTemplate(page: Page, name: string): Promise<void> {
  await selectRadixOption(
    page,
    page.getByRole("combobox", { name: "Template", exact: true }),
    new RegExp(name),
  );
}

function sidebarNewThread(page: Page): Locator {
  return page.getByTestId("desktop-sidebar").getByTestId("new-thread-trigger");
}

test("templates prefill editable thread creation and survive Agent drift", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSedesWorkspace(page);
  const initial = await applicationSnapshot(page);
  const workspace = initial.workspaces.find(
    ({ label, available }) => label.text === repositoryLabel && available,
  );
  const target = initial.executionTargets.find(
    (candidate) =>
      candidate.available &&
      candidate.backend.brand === "pi" &&
      candidate.environmentId === workspace?.environmentId,
  );
  expect(workspace).toBeDefined();
  expect(target).toBeDefined();
  if (!workspace || !target) throw new Error("template_e2e_scope_unavailable");

  const careful = await createAgent(page, "Template careful Agent");
  const fast = await createAgent(page, "Template fast Agent");

  await page.goto("/");
  await sidebarNewThread(page).click();
  const creation = page.getByRole("dialog", { name: "New thread" });
  await expect(creation).toBeVisible();
  await expect(
    creation.getByRole("combobox", { name: "Template", exact: true }),
  ).toContainText("Configure manually");
  await expect(creation.getByRole("combobox", { name: "Agent", exact: true })).toHaveText(
    /Choose (an Agent|Target and Project first)|Loading Agents…/,
  );
  await selectProjectIfNeeded(page, repositoryLabel);
  const targetPicker = creation.getByRole("combobox", {
    name: "Target",
    exact: true,
  });
  if ((await targetPicker.getAttribute("data-target-id")) !== target.id) {
    await selectRadixOption(page, targetPicker, "Pi SDK");
  }
  const selectedTargetId = await targetPicker.getAttribute("data-target-id");
  expect(selectedTargetId).toBeTruthy();
  await chooseAgent(page, careful.name);
  const saveAsTemplate = creation.getByRole("button", {
    name: "Save as template…",
  });
  await expect(saveAsTemplate).toBeEnabled();
  await saveAsTemplate.click();
  await creation
    .getByRole("textbox", { name: "Template name" })
    .fill("Careful launch");
  const templateCreated = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/thread-templates") &&
      response.status() === 201,
  );
  await creation.getByRole("button", { name: "Save template" }).click();
  await templateCreated;
  await expect(creation.getByText("Using Careful launch")).toBeVisible();

  await creation.getByRole("button", { name: "Cancel" }).click();
  await sidebarNewThread(page).click();
  const templatePicker = creation.getByRole("combobox", { name: "Template", exact: true });
  await templatePicker.click();
  const templateSearch = page.getByRole("combobox", { name: "Search templates", exact: true });
  await expect(templateSearch).toBeFocused();
  await templateSearch.fill("no-such-template");
  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(page.getByRole("option", { name: "Configure manually", exact: true })).toBeVisible();
  await expect(templatePicker).toContainText("Configure manually");
  await templateSearch.fill("careful");
  await expect(page.getByRole("option", { name: /Careful launch/ })).toBeVisible();
  await templateSearch.press("ArrowUp");
  await expect(page.getByRole("option", { name: "Configure manually", exact: true })).toHaveAttribute("data-active", "true");
  await templateSearch.press("ArrowDown");
  await templateSearch.press("Enter");
  await expect(templateSearch).toBeHidden();
  await expect(templatePicker).toBeFocused();
  await expect(creation.getByRole("combobox", { name: "Agent", exact: true })).toHaveText(
    careful.name,
  );
  await creation
    .getByRole("textbox", { name: "Thread name" })
    .fill("Title is not template state");
  await expect(creation.getByText("Using Careful launch")).toBeVisible();

  await chooseAgent(page, "Custom");
  await expect(
    creation.getByText("Modified from Careful launch"),
  ).toBeVisible();
  await expect(
    creation.getByRole("button", { name: "Update template…" }),
  ).toBeDisabled();
  await creation.getByRole("button", { name: "Reset changes" }).click();
  await expect(creation.getByRole("combobox", { name: "Agent", exact: true })).toHaveText(
    careful.name,
  );

  await chooseAgent(page, fast.name);
  await expect(
    creation.getByText("Modified from Careful launch"),
  ).toBeVisible();
  await creation.getByRole("button", { name: "Update template…" }).click();
  const templateUpdated = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().includes("/api/thread-templates/") &&
      response.ok(),
  );
  await expect(creation.getByRole("alert")).toContainText(
    "Replace Careful launch?",
  );
  await creation.getByRole("button", { name: "Replace template" }).click();
  await templateUpdated;
  await expect(creation.getByText("Using Careful launch")).toBeVisible();

  await creation.getByRole("button", { name: "Save as new…" }).click();
  await creation
    .getByRole("textbox", { name: "Template name" })
    .fill("Fast launch copy");
  const templateCopied = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/thread-templates") &&
      response.status() === 201,
  );
  await creation.getByRole("button", { name: "Save template" }).click();
  await templateCopied;
  await expect(creation.getByText("Using Fast launch copy")).toBeVisible();
  await capture(page, testInfo, "thread-template-drawer-desktop.png");

  const threadCreated = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/threads") &&
      response.status() === 201,
  );
  await creation
    .getByRole("textbox", { name: "Thread name" })
    .fill("Created from editable template");
  await creation.getByRole("button", { name: "Create thread" }).click();
  const threadResponse = await threadCreated;
  expect(threadResponse.request().postDataJSON()).toMatchObject({
    title: "Created from editable template",
    workspaceId: workspace.id,
    configuration: {
      kind: "saved_agent",
      agentId: fast.id,
      targetId: selectedTargetId,
    },
  });
  expect(threadResponse.request().postDataJSON()).not.toHaveProperty(
    "templateId",
  );
  await expect(page).toHaveURL(/\/threads\/[0-9a-f-]+$/u);
  // New Chat navigation defers composer focus until its panel is ready.
  // Let that handoff finish before opening a popover that dismisses on blur.
  await expect(page.getByRole("textbox", { name: /^Message /u })).toBeFocused();

  await page.getByRole("button", { name: "Thread actions" }).click();
  await page.getByRole("button", { name: "Session stats" }).click();
  const stats = page.getByRole("dialog", { name: "Session stats" });
  await expect(stats).toContainText("Created with");
  await expect(stats).toContainText(`${fast.name} · revision 0`);
  await stats.getByRole("button", { name: "Close" }).last().click();

  await deleteAgent(page, fast.id, fast.revision);
  await page.goto("/");
  await sidebarNewThread(page).click();
  await chooseTemplate(page, "Fast launch copy");
  await expect(creation.getByText("Needs attention")).toBeVisible();
  await expect(creation.getByRole("combobox", { name: "Agent", exact: true })).toHaveText(
    `${fast.name} (deleted)`,
  );
  await expect(
    creation.getByRole("button", { name: "Create thread" }),
  ).toBeDisabled();
  await creation.getByRole("button", { name: "Edit template…" }).click();
  await creation.getByRole("button", { name: "Delete template" }).click();
  await expect(creation.getByRole("alert")).toContainText(
    "Existing threads are unaffected",
  );
  const templateDeleted = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      response.url().includes("/api/thread-templates/") &&
      response.ok(),
  );
  await creation.getByRole("button", { name: "Delete", exact: true }).click();
  await templateDeleted;
  await expect(
    creation.getByRole("combobox", { name: "Template", exact: true }),
  ).toContainText("Configure manually");
  await creation.getByRole("button", { name: "Cancel" }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "New thread" }).last().click();
  const mobileSheet = page.getByRole("dialog", { name: "New thread" });
  await expect(mobileSheet).toBeVisible();
  await expect(page.locator(".new-thread-sheet-overlay")).toBeVisible();
  await expect
    .poll(async () => {
      const currentBox = await mobileSheet.boundingBox();
      return currentBox
        ? Math.abs(currentBox.y + currentBox.height - 844)
        : 844;
    })
    .toBeLessThanOrEqual(2);
  const box = await mobileSheet.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.abs(box!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(box!.width - 390)).toBeLessThanOrEqual(1);
  expect(Math.abs(box!.y + box!.height - 844)).toBeLessThanOrEqual(2);
  expect(
    await mobileSheet.evaluate(
      (element) => getComputedStyle(element).borderRadius,
    ),
  ).toMatch(/^16px 16px/u);
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "thread-template-sheet-mobile.png");
  const mobileTemplatePicker = mobileSheet.getByRole("combobox", { name: "Template", exact: true });
  await mobileTemplatePicker.click();
  await expect(templateSearch).not.toBeFocused();
  await templateSearch.click();
  await expect(templateSearch).toBeFocused();
  await templateSearch.fill("careful");
  const mobileTemplateOption = page.getByRole("option", { name: /Careful launch/ });
  await expect(mobileTemplateOption).toBeInViewport();
  await expect(templateSearch).toBeInViewport();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "thread-template-search-mobile.png");
  await templateSearch.press("Escape");
  await expect(templateSearch).toBeHidden();
  await expect(mobileTemplatePicker).toBeFocused();
  await expect(mobileSheet).toBeVisible();
});
