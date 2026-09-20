import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import type { NotificationPayload } from "../../src/shared/protocol/notification.js";
import { test, expect } from "./fixtures";
import {
  openSettingsPage,
  returnFromSettings,
  capture,
  createDraftThread,
  expectNoPageOverflow,
  fillAndPersistDraft,
  openWorkspaceDirectory,
  sendCurrentDraft,
} from "./helpers";
import { loadE2ERunContext } from "./run-context.js";

async function openNotifications(page: Page) {
  await openSettingsPage(page, "notifications");
  const settings = page.getByTestId("settings-view");
  return settings;
}

test("notification settings persist and passive server scripts follow selected lifecycle events", async ({
  page,
}, testInfo) => {
  const workspace = path.join(
    loadE2ERunContext().workspacesDirectory,
    "notification-hooks",
  );
  const scriptPath = path.join(workspace, "capture-notification.cjs");
  const payloadPath = path.join(workspace, "notifications.jsonl");
  await mkdir(workspace, { recursive: true });
  await writeFile(payloadPath, "");
  // An actual server-local executable validates the stdin/argument contract without
  // contacting an external notification provider or replacing the hook service.
  await writeFile(
    scriptPath,
    `#!${process.execPath}\nconst fs = require("node:fs");\nconst payload = JSON.parse(fs.readFileSync(0, "utf8"));\nfs.appendFileSync(process.argv[2], JSON.stringify(payload) + "\\n");\nprocess.stdout.write("Hook accepted JSON\\n");\n`,
    { mode: 0o700 },
  );
  const payloads = async (): Promise<NotificationPayload[]> =>
    (await readFile(payloadPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as NotificationPayload);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await openWorkspaceDirectory(page, workspace);
  const threadPath = await createDraftThread(page);
  const threadId = threadPath.split("/").at(-1)!;
  let settings = await openNotifications(page);
  await settings
    .getByRole("checkbox", { name: "Enable notifications", exact: true })
    .check();
  await settings
    .getByLabel("Server script path", { exact: true })
    .fill(scriptPath);
  await settings
    .getByLabel("Arguments (one per line)", { exact: true })
    .fill(payloadPath);
  await settings.getByLabel("Timeout (seconds)", { exact: true }).fill("10");
  await settings
    .getByRole("checkbox", { name: "Turn completed", exact: true })
    .check();
  await expect(settings.getByRole("group", { name: "Response text", exact: true })).toBeVisible();
  await expect(settings.getByRole("checkbox", { name: "Include assistant response text", exact: true })).toHaveCount(0);
  for (const name of ["Provisional", "Unclassified", "Final"]) {
    const phase = settings.getByRole("checkbox", { name, exact: true });
    await expect(phase).not.toBeChecked();
    await expect(phase).toBeEnabled();
    await phase.check();
  }
  await settings
    .getByRole("checkbox", { name: "Automation started", exact: true })
    .check();
  for (const name of ["Approval requested", "Input requested"]) {
    const checkbox = settings.getByRole("checkbox", { name, exact: true });
    await expect(checkbox).not.toBeChecked();
    await checkbox.check();
  }
  for (const name of [
    "Turn failed",
    "Turn interrupted",
    "Snooze wake",
    "Automation failed before starting",
  ]) {
    await settings.getByRole("checkbox", { name, exact: true }).uncheck();
  }
  await settings
    .getByRole("button", { name: "Save notifications", exact: true })
    .click();
  await expect(
    settings.getByText("Notification settings saved.", { exact: true }),
  ).toBeVisible();
  await settings
    .getByRole("button", { name: "Send test notification", exact: true })
    .click();
  await expect(
    settings.getByText("Test notification script completed successfully.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect.poll(async () => (await payloads()).length).toBe(1);
  expect((await payloads())[0]).toMatchObject({
    schemaVersion: 3,
    event: "notification.test",
    notificationId: expect.any(String),
  });
  expect((await payloads())[0]).not.toHaveProperty("assistantResult");
  await settings
    .getByRole("heading", { name: "Notifications", exact: true })
    .scrollIntoViewIfNeeded();
  await capture(page, testInfo, "notification-settings-desktop.png");

  await page.reload();
  settings = page.getByTestId("settings-view");
  await expect(settings).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/notifications$/u);
  await expect(
    settings.getByLabel("Server script path", { exact: true }),
  ).toHaveValue(scriptPath);
  await expect(
    settings.getByLabel("Arguments (one per line)", { exact: true }),
  ).toHaveValue(payloadPath);
  await expect(
    settings.getByRole("checkbox", { name: "Automation started", exact: true }),
  ).toBeChecked();
  for (const name of ["Approval requested", "Input requested"]) {
    await expect(
      settings.getByRole("checkbox", { name, exact: true }),
    ).toBeChecked();
  }
  for (const name of ["Provisional", "Final", "Unclassified"]) {
    await expect(settings.getByRole("checkbox", { name, exact: true })).toBeChecked();
  }
  // The saved selection controls which sections the external script receives.
  await settings.getByRole("checkbox", { name: "Provisional", exact: true }).uncheck();
  await settings.getByRole("button", { name: "Save notifications", exact: true }).click();
  await expect(settings.getByText("Notification settings saved.", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoPageOverflow(page);
  await settings
    .getByRole("heading", { name: "Notifications", exact: true })
    .scrollIntoViewIfNeeded();
  await capture(page, testInfo, "notification-settings-mobile.png");
  await settings
    .getByRole("checkbox", { name: "Automation started", exact: true })
    .scrollIntoViewIfNeeded();
  await capture(page, testInfo, "notification-settings-mobile-events.png");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await returnFromSettings(page);
  // A reloaded Settings deep link has no parked chat; reopen the same thread.
  await page.goto(threadPath);

  await fillAndPersistDraft(page, "Exercise a passive completion notification");
  await sendCurrentDraft(page);
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Live summary", exact: true }),
  ).toBeVisible({ timeout: 12_000 });
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeVisible();
  await capture(page, testInfo, "notification-thread-streaming.png");
  await expect
    .poll(
      async () =>
        (await payloads()).filter(
          (payload) => payload.event === "turn.completed",
        ).length,
      { timeout: 15_000 },
    )
    .toBe(1);
  const completion = (await payloads()).find(
    (payload) => payload.event === "turn.completed",
  )!;
  expect(completion).toMatchObject({
    schemaVersion: 3,
    thread: { id: threadId },
    turn: { id: expect.any(String), outcome: "completed" },
  });
  expect(completion.assistantResult).toMatchObject({
    final: null,
    unclassified: { text: expect.any(String) },
  });
  expect(Object.keys(completion.assistantResult!).sort()).toEqual(["final", "unclassified"]);
  expect(completion.assistantResult!.unclassified).not.toHaveProperty("truncation");
  expect(completion.assistantResult!.unclassified!.text.length).toBeGreaterThan(0);
  expect(completion).not.toHaveProperty("prompt");
  expect(completion).not.toHaveProperty("transcript");

  await page
    .getByRole("button", {
      name: "Silence external notifications",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Resume external notifications",
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: "Resume external notifications",
      exact: true,
    }),
  ).toBeVisible();
  await capture(page, testInfo, "notification-thread-silenced.png");
  await fillAndPersistDraft(
    page,
    "Complete this turn while notifications are silenced",
  );
  await sendCurrentDraft(page);
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeHidden({ timeout: 15_000 });
  await page
    .getByRole("button", { name: "Resume external notifications", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Silence external notifications",
      exact: true,
    }),
  ).toBeVisible();

  const sessionResponse = await page.request.get("/api/application/session");
  expect(sessionResponse.ok()).toBe(true);
  const session = (await sessionResponse.json()) as { csrfToken: string };
  const headers = { "X-CSRF-Token": session.csrfToken };
  const created = await page.request.post(
    `/api/threads/${threadId}/automation`,
    {
      headers,
      data: {
        prompt: "Exercise automation start notification",
        runMode: "clone",
        schedule: {
          kind: "date_time",
          runAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
        misfirePolicy: "skip",
        precheck: null,
        mutationId: randomUUID(),
      },
    },
  );
  expect(created.ok()).toBe(true);
  const started = await page.request.post(
    `/api/threads/${threadId}/automation/run-now`,
    { headers, data: { mutationId: randomUUID() } },
  );
  expect(started.ok()).toBe(true);
  await expect
    .poll(
      async () =>
        (await payloads()).filter(
          (payload) => payload.event === "automation.started",
        ).length,
    )
    .toBe(1);
  expect(
    (await payloads()).find(
      (payload) => payload.event === "automation.started",
    ),
  ).toMatchObject({
    automation: {
      id: expect.any(String),
      runId: expect.any(String),
      trigger: "manual",
    },
  });
  await expect
    .poll(
      async () =>
        (await payloads()).filter(
          (payload) => payload.event === "turn.completed",
        ).length,
      { timeout: 15_000 },
    )
    .toBe(2);
  // The active and automation turns notify, but the intervening muted turn does
  // not reappear when resumed. UI acknowledgment is independent throughout.
  expect(
    (await payloads()).filter(
      (payload) =>
        payload.event === "turn.completed" && payload.thread?.id === threadId,
    ),
  ).toHaveLength(1);
});
