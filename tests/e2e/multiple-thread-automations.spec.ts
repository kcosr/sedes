import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { normalizedThreadSnapshotSchema } from "../../src/shared/protocol/conversation.js";
import { expect, test } from "./fixtures";
import {
  capture,
  createDraftThread,
  expectNoPageOverflow,
  openWorkspaceDirectory,
} from "./helpers";
import { loadE2ERunContext } from "./run-context.js";

const automationRow = (page: Page, automationId: string) =>
  page.locator(`[data-testid="automation-row"][data-automation-id="${automationId}"]`);

async function createSource(page: Page, fixture: string): Promise<string> {
  const workspace = path.join(loadE2ERunContext().workspacesDirectory, fixture);
  await mkdir(workspace, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkspaceDirectory(page, workspace);
  return (await createDraftThread(page, "Assistant source")).split("/").at(-1)!;
}

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const response = await page.request.get("/api/application/session");
  expect(response.ok()).toBe(true);
  return { "X-CSRF-Token": ((await response.json()) as { csrfToken: string }).csrfToken };
}

async function createInEditor(
  page: Page,
  input: { name: string; prompt: string; once?: boolean },
): Promise<string> {
  await page.getByRole("button", { name: "Add automation", exact: true }).click();
  const editor = page.getByRole("region", { name: "New automation", exact: true });
  await editor.getByRole("textbox", { name: "Name", exact: true }).fill(input.name);
  await editor.getByRole("textbox", { name: "Prompt", exact: true }).fill(input.prompt);
  if (input.once) await editor.getByRole("radio", { name: "Once", exact: true }).click();
  const saved = page.waitForResponse(response =>
    response.request().method() === "POST" && response.url().endsWith("/api/automations") && response.ok());
  await editor.getByRole("button", { name: "Save and enable", exact: true }).click();
  const automationId = ((await (await saved).json()) as { id: string }).id;
  await expect(page).toHaveURL(`/automations/${automationId}`);
  return automationId;
}

test("keeps named daily and one-shot automations independent on the same draft", async ({ page }, testInfo) => {
  const sourceId = await createSource(page, "multiple-automation-editor");
  await page.getByRole("button", { name: "Thread actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Automations…", exact: true }).click();
  await expect(page).toHaveURL(`/threads/${sourceId}/automations`);

  const dailyId = await createInEditor(page, {
    name: "Daily update",
    prompt: "Summarize today's work and tomorrow's priorities.",
  });
  await page.goto(`/threads/${sourceId}/automations`);
  const reminderId = await createInEditor(page, {
    name: "Afternoon reminder",
    prompt: "Remind me to send the release notes.",
    once: true,
  });
  expect(reminderId).not.toBe(dailyId);

  await page.goto(`/threads/${sourceId}/automations`);
  await expect(page.getByTestId("automation-row")).toHaveCount(2);
  await expect(automationRow(page, dailyId)).toContainText("Daily update");
  await expect(automationRow(page, reminderId)).toContainText("Afternoon reminder");
  await capture(page, testInfo, "multiple-automations-draft-desktop.png");

  // These siblings initially have equal revisions. Opening one after the other
  // must load by automation identity rather than reuse the first editor's cache.
  await automationRow(page, dailyId).getByRole("link", { name: "Daily update", exact: true }).click();
  await page.getByRole("button", { name: "Edit automation", exact: true }).click();
  const editor = page.getByRole("region", { name: "Automation editor", exact: true });
  await expect(editor.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Daily update");
  await expect(editor.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue(
    "Summarize today's work and tomorrow's priorities.",
  );
  await editor.getByRole("textbox", { name: "Name", exact: true }).fill("Morning update");
  await editor.getByRole("textbox", { name: "Prompt", exact: true }).fill("Summarize today's priorities at breakfast.");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(`/automations/${dailyId}`);
  await expect(page.getByRole("heading", { level: 1, name: "Morning update", exact: true })).toBeVisible();

  await page.goto(`/automations/${reminderId}/edit`);
  await expect(editor.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Afternoon reminder");
  await expect(editor.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("Remind me to send the release notes.");
  await expect(editor.getByRole("radio", { name: "Once", exact: true })).toBeChecked();

  // Pause just the recurring schedule. Its sibling remains enabled, and the
  // source stays a draft because configuring an automation does not start it.
  await page.goto(`/automations/${dailyId}`);
  await page.getByRole("button", { name: "Pause automation", exact: true }).click();
  await expect.poll(async () => {
    const response = await page.request.get(`/api/automations/${dailyId}`);
    expect(response.ok()).toBe(true);
    return ((await response.json()) as { status: string }).status;
  }).toBe("paused");
  const reminder = await page.request.get(`/api/automations/${reminderId}`);
  expect(reminder.ok()).toBe(true);
  expect(await reminder.json()).toMatchObject({ name: "Afternoon reminder", status: "enabled" });
  const source = await page.request.get(`/api/threads/${sourceId}?activityDetail=full`);
  expect(source.ok()).toBe(true);
  expect(await source.json()).toMatchObject({ thread: { backingState: "unbound" } });

  await page.goto(`/threads/${sourceId}/automations`);
  await page.setViewportSize({ width: 390, height: 844 });
  const search = page.getByRole("searchbox", { name: "Search automations" });
  await expect.poll(async () => (await search.boundingBox())?.width ?? 0)
    .toBeGreaterThanOrEqual(200);
  await search.fill("Morning update");
  await expect(page.getByTestId("automation-row")).toHaveCount(1);
  await expect(automationRow(page, dailyId)).toBeVisible();
  await search.fill("");
  await expect(page.getByTestId("automation-row")).toHaveCount(2);
  const reminderRow = automationRow(page, reminderId);
  await expect(reminderRow).toBeVisible();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "multiple-automations-draft-mobile.png");
  // The row link remains keyboard operable at phone width.
  const reminderLink = reminderRow.getByRole("link", { name: "Afternoon reminder", exact: true });
  await reminderLink.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`/automations/${reminderId}`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Edit automation", exact: true }).click();
  await editor.getByRole("button", { name: "Delete automation…", exact: true }).click();
  await page.getByRole("dialog", { name: "Delete this automation?" })
    .getByRole("button", { name: "Delete automation", exact: true }).click();
  await expect(page).toHaveURL("/automations");
  await expect(automationRow(page, reminderId)).toHaveCount(0);
  await expect(automationRow(page, dailyId)).toContainText("Morning update");
  await page.goto(`/threads/${sourceId}/automations`);
  await expect(page.getByTestId("automation-row")).toHaveCount(1);
  await expect(automationRow(page, dailyId)).toContainText("Morning update");
});

test("fork creates a fresh result from a draft or started source without inheriting schedules", async ({ page }, testInfo) => {
  const sourceId = await createSource(page, "multiple-automation-fork");
  const reasoning = page.getByTestId("thread-configuration")
    .locator('[data-setting-id="thinking_level"] [role="combobox"]');
  await reasoning.click();
  await page.getByRole("option", { name: "High", exact: true }).click();
  await expect(reasoning).toHaveText("High");
  const headers = await csrfHeaders(page);
  const create = async (name: string, runMode: "clone" | "same_thread") => {
    const response = await page.request.post("/api/automations", {
      headers,
      data: {
        threadId: sourceId,
        name,
        prompt: "Measure turn throughput",
        runMode,
        initialState: "paused",
        schedule: { kind: "interval", everySeconds: 86400, anchorAt: new Date(Date.now() + 3600000).toISOString() },
        misfirePolicy: "coalesce",
        precheck: null,
        mutationId: randomUUID(),
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return ((await response.json()) as { id: string }).id;
  };
  const forkId = await create("Separate review", "clone");
  const sameThreadId = await create("Daily update", "same_thread");

  const run = async (automationId: string): Promise<string> => {
    await page.goto(`/automations/${automationId}`);
    const started = page.waitForResponse(response =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/automations/${automationId}/run-now`) && response.ok());
    await page.getByRole("button", { name: "Run now", exact: true }).click();
    const runId = ((await (await started).json()) as { id: string }).id;
    let resultThreadId: string | undefined;
    await expect.poll(async () => {
      const response = await page.request.get(`/api/automations/${automationId}/runs`);
      expect(response.ok()).toBe(true);
      const history = (await response.json()) as {
        items: Array<{ id: string; resultThreadId?: string; turn?: { outcome: string } }>;
      };
      const current = history.items.find(item => item.id === runId);
      resultThreadId = current?.resultThreadId;
      return current?.turn?.outcome;
    }).toBe("completed");
    expect(resultThreadId).toBeDefined();
    return resultThreadId!;
  };

  const firstChildId = await run(forkId);
  const secondChildId = await run(forkId);
  expect(new Set([sourceId, firstChildId, secondChildId]).size).toBe(3);
  const sourceBeforeStart = await page.request.get(`/api/threads/${sourceId}?activityDetail=full`);
  expect(sourceBeforeStart.ok()).toBe(true);
  const sourceSnapshot = normalizedThreadSnapshotSchema.parse(await sourceBeforeStart.json());
  expect(sourceSnapshot).toMatchObject({ thread: { backingState: "unbound" }, orderedTurnIds: [] });
  for (const childId of [firstChildId, secondChildId]) {
    const childResponse = await page.request.get(`/api/threads/${childId}?activityDetail=full`);
    expect(childResponse.ok()).toBe(true);
    const child = normalizedThreadSnapshotSchema.parse(await childResponse.json());
    expect(child.thread).toMatchObject({
      targetId: sourceSnapshot.thread.targetId,
      workspaceId: sourceSnapshot.thread.workspaceId,
    });
    expect(child.settings.values.map(({ id, desiredValue }) => ({ id, desiredValue })))
      .toEqual(sourceSnapshot.settings.values.map(({ id, desiredValue }) => ({ id, desiredValue })));
    expect(child.agentTools).toMatchObject({
      enabled: sourceSnapshot.agentTools.enabled,
      presentation: sourceSnapshot.agentTools.presentation,
      accessBoundary: sourceSnapshot.agentTools.accessBoundary,
    });
  }

  const sameThreadResult = await run(sameThreadId);
  expect(sameThreadResult).toBe(sourceId);
  const nativeChildId = await run(forkId);
  expect(new Set([sourceId, firstChildId, secondChildId, nativeChildId]).size).toBe(4);

  for (const childId of [firstChildId, secondChildId, nativeChildId]) {
    const childAutomations = await page.request.get(`/api/automations?threadId=${childId}`);
    expect(childAutomations.ok()).toBe(true);
    expect(await childAutomations.json()).toMatchObject({ items: [] });
  }
  const snapshotResponse = await page.request.get("/api/application/snapshot");
  expect(snapshotResponse.ok()).toBe(true);
  const snapshot = (await snapshotResponse.json()) as {
    forkOrigins: Array<{ sourceThreadId: string; childThreadId: string }>;
  };
  expect(snapshot.forkOrigins.some(origin => origin.childThreadId === firstChildId)).toBe(false);
  expect(snapshot.forkOrigins.some(origin => origin.childThreadId === secondChildId)).toBe(false);
  expect(snapshot.forkOrigins).toContainEqual(expect.objectContaining({ sourceThreadId: sourceId, childThreadId: nativeChildId }));

  await page.goto(`/automations/${forkId}`);
  await expect(page.getByRole("button", { name: /\sFinished(?: in [^,]+)?, Manual$/u })).toHaveCount(3);
  await capture(page, testInfo, "automation-fork-results.png");
  await page.goto(`/threads/${firstChildId}/automations`);
  await expect(page.getByTestId("automation-row")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add automation", exact: true })).toBeEnabled();
});
