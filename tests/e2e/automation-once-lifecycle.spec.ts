import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { threadAutomationRunPageSchema, type ThreadAutomationRun } from "../../src/shared/protocol/automation-presentation.js";
import { normalizedThreadSnapshotSchema } from "../../src/shared/protocol/conversation.js";
import { expect, test } from "./fixtures";
import { capture, createDraftThread, openWorkspaceDirectory } from "./helpers";
import { loadE2ERunContext } from "./run-context.js";

async function fixture(page: Page, name: string) {
  const workspace = path.join(loadE2ERunContext().workspacesDirectory, name);
  await mkdir(workspace, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkspaceDirectory(page, workspace);
  const threadId = (await createDraftThread(page, "Assistant reminders")).split("/").at(-1)!;
  const session = await page.request.get("/api/application/session");
  expect(session.ok()).toBe(true);
  const headers = { "X-CSRF-Token": ((await session.json()) as { csrfToken: string }).csrfToken };
  const create = async (name: string, prompt: string, recurring = false) => {
    const response = await page.request.post("/api/automations", {
      headers,
      data: {
        threadId, name, prompt, runMode: "same_thread", initialState: "enabled",
        schedule: recurring
          ? { kind: "interval", everySeconds: 86400, anchorAt: new Date(Date.now() + 3_600_000).toISOString() }
          : { kind: "date_time", runAt: new Date(Date.now() + 2_000).toISOString() },
        misfirePolicy: recurring ? "coalesce" : null,
        precheck: null,
        mutationId: randomUUID(),
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return ((await response.json()) as { id: string }).id;
  };
  const run = async (automationId: string): Promise<ThreadAutomationRun | undefined> => {
    const response = await page.request.get(`/api/automations/${automationId}/runs`);
    expect(response.ok()).toBe(true);
    return threadAutomationRunPageSchema.parse(await response.json()).items[0];
  };
  const startScheduled = async (automationId: string) => {
    await expect.poll(async () => {
      expect((await page.request.post("/__e2e/automations/reconcile")).status()).toBe(204);
      return (await run(automationId))?.state;
    }).toBe("completed");
    const started = (await run(automationId))!;
    expect(started.occurrence).toBe("scheduled");
    expect(started.resultThreadId).toBe(threadId);
    return started;
  };
  const notice = (name: string) => page.locator(".automation-context").filter({ hasText: name });
  const sidebarRow = () => page.getByTestId("desktop-sidebar").locator(`[data-thread-id="${threadId}"]`).first();
  const dismiss = async (name: string, outcome: "triggered" | "failed") => {
    const response = page.waitForResponse(value => value.request().method() === "POST" &&
      value.url().endsWith(`/api/threads/${threadId}/attention/dismiss`));
    await notice(name).getByRole("button", { name: "Dismiss", exact: true }).click();
    const dismissed = await response;
    expect(dismissed.ok()).toBe(true);
    expect(dismissed.request().postDataJSON()).toMatchObject({ kind: "automation_context", outcome });
    await expect(notice(name)).toHaveCount(0);
  };
  return { threadId, headers, create, run, startScheduled, notice, sidebarRow, dismiss };
}

const row = (page: Page, automationId: string) =>
  page.locator(`[data-testid="automation-row"][data-automation-id="${automationId}"]`);

async function expandAutomationGroups(page: Page): Promise<void> {
  await expect(page.getByTestId("automations-group").first()).toBeVisible();
  for (const toggle of await page.locator('.automations-group-toggle[aria-expanded="false"]').all()) {
    await toggle.click();
  }
}

test("a successful one-shot keeps its banner until dismissal and leaves a recurring sibling intact", async ({ page }, testInfo) => {
  const f = await fixture(page, "once-success-dismissal");
  const id = await f.create("Send release notes", "Measure turn throughput");
  await f.startScheduled(id);
  await expect.poll(async () => (await f.run(id))?.turn?.outcome).toBe("completed");
  await expect(f.notice("Send release notes")).toContainText("triggered this thread.");
  await expect(f.sidebarRow()).toBeVisible();
  await expect(f.sidebarRow().locator("[data-automation-glyph]")).toHaveCount(0);
  await capture(page, testInfo, "once-success-banner-no-sidebar-icon.png");

  // Success alone keeps the definition available while the trigger banner is visible.
  await page.goto(`/threads/${f.threadId}/automations`);
  await expandAutomationGroups(page);
  await expect(row(page, id)).toContainText("Send release notes");
  await page.goto(`/threads/${f.threadId}`);
  await f.dismiss("Send release notes", "triggered");
  await expect.poll(async () => (await page.request.get(`/api/automations/${id}`)).status()).toBe(404);
  await page.goto("/automations");
  await expect(row(page, id)).toHaveCount(0);
  await page.goto(`/threads/${f.threadId}/automations`);
  await expect(page.getByTestId("automation-row")).toHaveCount(0);

  const recurringId = await f.create("Daily update", "Measure turn throughput", true);
  const siblingId = await f.create("Send another reminder", "Measure turn throughput");
  await page.goto(`/threads/${f.threadId}`);
  await f.startScheduled(siblingId);
  await expect.poll(async () => (await f.run(siblingId))?.turn?.outcome).toBe("completed");
  await expect(f.sidebarRow().locator('[data-automation-glyph="repeat"]')).toBeVisible();
  await f.dismiss("Send another reminder", "triggered");
  await expect(f.sidebarRow().locator('[data-automation-glyph="repeat"]')).toBeVisible();
  await page.goto(`/threads/${f.threadId}/automations`);
  await expect(page.getByTestId("automation-row")).toHaveCount(1);
  await expect(row(page, recurringId)).toContainText("Daily update");
  await expect(row(page, siblingId)).toHaveCount(0);
  const recurring = await page.request.get(`/api/automations/${recurringId}`);
  expect(recurring.ok()).toBe(true);
  expect(await recurring.json()).toMatchObject({ status: "enabled" });

  // Retiring definitions preserves their completed thread and transcript.
  const response = await page.request.get(`/api/threads/${f.threadId}?activityDetail=full`);
  expect(response.ok()).toBe(true);
  const snapshot = normalizedThreadSnapshotSchema.parse(await response.json());
  expect(snapshot.orderedTurnIds).toHaveLength(2);
  expect(Object.values(snapshot.turnsById).every(turn => turn.status === "completed")).toBe(true);
});

for (const outcome of ["completed", "failed"] as const) {
  test(`dismissing a running one-shot waits for its ${outcome} turn outcome`, async ({ page }, testInfo) => {
    const f = await fixture(page, `once-early-dismissal-${outcome}`);
    expect((await page.request.post("/__e2e/pi/turn-response/arm")).status()).toBe(204);
    const name = "Afternoon reminder";
    try {
      const id = await f.create(name, outcome === "failed"
        ? "Fail with a visible model configuration diagnostic"
        : "Measure turn throughput");
      const started = await f.startScheduled(id);
      expect(started.turn).toBeUndefined();
      await expect(f.notice(name)).toContainText("triggered this thread.");
      await f.dismiss(name, "triggered");
      await page.goto(`/threads/${f.threadId}/automations`);
      await expandAutomationGroups(page);
      await expect(row(page, id)).toBeVisible();
      await page.goto(`/threads/${f.threadId}`);
      await expect(page.getByRole("textbox", { name: "Message Scripted agent", exact: true })).toBeVisible();
      await expect(f.notice(name)).toHaveCount(0);
      await capture(page, testInfo, `once-early-dismissal-${outcome}-running.png`);

      expect((await page.request.post("/__e2e/pi/turn-response/release")).status()).toBe(204);
      if (outcome === "completed") {
        await expect.poll(async () => (await page.request.get(`/api/automations/${id}`)).status()).toBe(404);
        await expect(f.sidebarRow().locator("[data-automation-glyph]")).toHaveCount(0);
        const response = await page.request.get(`/api/threads/${f.threadId}?activityDetail=full`);
        expect(response.ok()).toBe(true);
        const snapshot = normalizedThreadSnapshotSchema.parse(await response.json());
        expect(snapshot.orderedTurnIds).toHaveLength(1);
        expect(snapshot.turnsById[snapshot.orderedTurnIds[0]!]?.status).toBe("completed");
        await page.goto(`/threads/${f.threadId}/automations`);
        await expect(row(page, id)).toHaveCount(0);
      } else {
        await expect.poll(async () => (await f.run(id))?.turn?.outcome).toBe("failed");
        await expect(f.notice(name)).toContainText("this run failed.");
        await expect(f.notice(name)).toContainText("agent turn failed.");
        // A stale trigger acknowledgement must not dismiss the newly reported failure.
        const stale = await page.request.post(`/api/threads/${f.threadId}/attention/dismiss`, {
          headers: f.headers,
          data: { kind: "automation_context", runId: started.id, outcome: "triggered", mutationId: randomUUID() },
        });
        expect(stale.ok()).toBe(true);
        await page.reload();
        await expect(f.notice(name)).toContainText("this run failed.");
        await capture(page, testInfo, "once-failure-after-trigger-dismissal.png");
        await f.dismiss(name, "failed");
        await page.goto(`/threads/${f.threadId}/automations`);
        await expect(row(page, id)).toContainText(name);
        expect((await page.request.get(`/api/automations/${id}`)).ok()).toBe(true);
      }
    } finally {
      await page.request.post("/__e2e/pi/turn-response/reset");
    }
  });
}
