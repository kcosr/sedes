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
  selectCustomNewThreadTarget,
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
  // An actual server-local interpreter validates the stdin/argument contract without
  // contacting an external notification provider or replacing the hook service.
  await writeFile(
    scriptPath,
    `const fs = require("node:fs");\nconst payload = JSON.parse(fs.readFileSync(0, "utf8"));\nfs.appendFileSync(process.argv[2], JSON.stringify(payload) + "\\n");\nprocess.stdout.write("Hook accepted JSON\\n");\n`,
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
    .getByRole("switch", { name: "Enable notifications", exact: true })
    .check();
  await settings
    .getByLabel("Server script path", { exact: true })
    .fill(process.execPath);
  await settings
    .getByLabel("Arguments (one per line)", { exact: true })
    .fill([scriptPath, payloadPath].join("\n"));
  await settings.getByLabel("Timeout (seconds)", { exact: true }).fill("10");
  const partialScript = settings.getByRole("switch", { name: "Script: Partial", exact: true });
  const progressScript = settings.getByRole("switch", { name: "Script: Turn progress", exact: true });
  await expect(partialScript).not.toBeChecked();
  await expect(progressScript).not.toBeChecked();
  await partialScript.check();
  const partialVoice = settings.getByRole("combobox", { name: "Voice: Partial", exact: true });
  await expect(partialVoice).toHaveText("Off");
  await partialVoice.click();
  await expect(page.getByRole("option")).toHaveText(["Off", "Speak"]);
  await page.getByRole("option", { name: "Speak", exact: true }).click();
  await settings
    .getByRole("switch", { name: "Script: Turn completed", exact: true })
    .check();
  await expect(settings.getByRole("group", { name: "Response text", exact: true })).toBeVisible();
  await expect(settings.getByRole("checkbox", { name: "Include assistant response text", exact: true })).toHaveCount(0);
  for (const name of ["Provisional", "Partial", "Unclassified", "Final"]) {
    const phase = settings.getByRole("checkbox", { name, exact: true });
    if (name === "Provisional" || name === "Partial") await expect(phase).not.toBeChecked();
    else await expect(phase).toBeChecked();
    await expect(phase).toBeEnabled();
    await phase.check();
  }
  await settings
    .getByRole("switch", { name: "Script: Automation started", exact: true })
    .check();
  for (const name of ["Script: Approval requested", "Script: Input requested"]) {
    const event = settings.getByRole("switch", { name, exact: true });
    await expect(event).not.toBeChecked();
    await event.check();
  }
  for (const name of [
    "Script: Turn failed",
    "Script: Turn interrupted",
    "Script: Snooze wake",
    "Script: Automation failed before starting",
  ]) {
    await settings.getByRole("switch", { name, exact: true }).uncheck();
  }
  await settings
    .getByRole("button", { name: "Save notifications", exact: true })
    .click();
  // "Saved" shows briefly in the save bar, which then has nothing to save.
  await expect(settings.locator('[data-slot="save-bar-status"]')).toHaveText("Saved");
  await expect(settings.getByRole("button", { name: "Save notifications", exact: true })).toBeDisabled();
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
    schemaVersion: 5,
    event: "notification.test",
    notificationId: expect.any(String),
  });
  expect((await payloads())[0]).not.toHaveProperty("assistantResult");
  await settings
    .getByRole("heading", { name: "Notifications", exact: true })
    .scrollIntoViewIfNeeded();
  await capture(page, testInfo, "notification-settings-desktop.png");
  await settings.getByRole("group", { name: "Response text", exact: true })
    .evaluate(element => element.scrollIntoView({ block: "center" }));
  await capture(page, testInfo, "notification-response-phases-desktop.png");

  await page.reload();
  settings = page.getByTestId("settings-view");
  await expect(settings).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/notifications$/u);
  await expect(
    settings.getByLabel("Server script path", { exact: true }),
  ).toHaveValue(process.execPath);
  await expect(
    settings.getByLabel("Arguments (one per line)", { exact: true }),
  ).toHaveValue([scriptPath, payloadPath].join("\n"));
  await expect(
    settings.getByRole("switch", { name: "Script: Automation started", exact: true }),
  ).toBeChecked();
  for (const name of ["Script: Approval requested", "Script: Input requested"]) {
    await expect(
      settings.getByRole("switch", { name, exact: true }),
    ).toBeChecked();
  }
  for (const name of ["Provisional", "Partial", "Final", "Unclassified"]) {
    await expect(settings.getByRole("checkbox", { name, exact: true })).toBeChecked();
  }
  await expect(settings.getByRole("switch", { name: "Script: Partial", exact: true })).toBeChecked();
  await expect(settings.getByRole("switch", { name: "Script: Turn progress", exact: true })).not.toBeChecked();
  await expect(settings.getByRole("combobox", { name: "Voice: Partial", exact: true })).toHaveText("Speak");
  // The saved selection controls which sections the external script receives.
  await settings.getByRole("checkbox", { name: "Provisional", exact: true }).uncheck();
  await settings.getByRole("button", { name: "Save notifications", exact: true }).click();
  await expect(settings.locator('[data-slot="save-bar-status"]')).toHaveText("Saved");
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoPageOverflow(page);
  await settings
    .getByRole("heading", { name: "Notifications", exact: true })
    .scrollIntoViewIfNeeded();
  await capture(page, testInfo, "notification-settings-mobile.png");
  await settings.getByRole("group", { name: "Response text", exact: true })
    .evaluate(element => element.scrollIntoView({ block: "center" }));
  await capture(page, testInfo, "notification-response-phases-mobile.png");
  await settings
    .getByRole("switch", { name: "Script: Automation started", exact: true })
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
    schemaVersion: 5,
    thread: { id: threadId },
    turn: { id: expect.any(String), outcome: "completed" },
  });
  expect(completion.assistantResult).toMatchObject({
    final: null,
    partial: null,
    unclassified: { text: expect.any(String) },
  });
  expect(Object.keys(completion.assistantResult!).sort()).toEqual(["final", "partial", "unclassified"]);
  expect(completion.assistantResult!.unclassified).not.toHaveProperty("truncation");
  expect(completion.assistantResult!.unclassified!.text.length).toBeGreaterThan(0);
  expect(completion).not.toHaveProperty("prompt");
  expect(completion).not.toHaveProperty("transcript");

  await page
    .getByRole("button", {
      name: "Silence notifications",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Resume notifications",
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: "Resume notifications",
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
    .getByRole("button", { name: "Resume notifications", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Silence notifications",
      exact: true,
    }),
  ).toBeVisible();

  const sessionResponse = await page.request.get("/api/application/session");
  expect(sessionResponse.ok()).toBe(true);
  const session = (await sessionResponse.json()) as { csrfToken: string };
  const headers = { "X-CSRF-Token": session.csrfToken };
  const created = await page.request.post(
    "/api/automations",
    {
      headers,
      data: {
        threadId,
        name: "Automation notification",
        initialState: "paused",
        prompt: "Exercise automation start notification",
        runMode: "clone",
        schedule: {
          kind: "date_time",
          runAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
        misfirePolicy: null,
        precheck: null,
        mutationId: randomUUID(),
      },
    },
  );
  expect(created.ok()).toBe(true);
  const automation = (await created.json()) as { id: string };
  const started = await page.request.post(
    `/api/automations/${automation.id}/run-now`,
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

  // Partial delivery is selected independently from provisional progress. Both
  // provider-shaped items arrive while a submitted Codex turn remains active.
  await page.getByTestId("desktop-sidebar").getByTestId("new-thread-trigger").click();
  await selectCustomNewThreadTarget(page, "Codex TCP external · Codex TCP");
  await page.getByRole("textbox", { name: "Thread name", exact: true }).fill("Partial notification");
  const codexCreated = page.waitForResponse(response => response.request().method() === "POST" &&
    response.url().endsWith("/api/threads") && response.status() === 201);
  await page.getByRole("button", { name: "Create thread", exact: true }).click();
  await codexCreated;
  await expect(page.getByRole("textbox", { name: "Message Codex TCP", exact: true })).toBeVisible();
  const codexThreadId = new URL(page.url()).pathname.split("/").at(-1)!;
  expect((await page.request.post("/__e2e/codex/turn-completion/arm")).status()).toBe(204);
  await fillAndPersistDraft(page, "Check compatibility and share the first confirmed finding", "Message Codex TCP");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  await sendCurrentDraft(page);
  const codexTurn = page.locator(".conversation-turn").last();
  await expect(codexTurn.getByTestId("activity-group")).toBeVisible();
  expect((await page.request.post(`/__e2e/codex/partial-answer/${codexThreadId}`)).status()).toBe(204);
  await expect.poll(async () => (await payloads()).filter(payload => payload.event === "turn.partial").length).toBe(1);
  const partial = (await payloads()).find(payload => payload.event === "turn.partial")!;
  expect(partial).toMatchObject({
    thread: { id: codexThreadId },
    progress: { phase: "partial", text: "The first compatibility finding is confirmed. I am checking the remaining paths." },
  });
  expect((await payloads()).filter(payload => payload.event === "turn.progress")).toHaveLength(0);
  expect((await payloads()).filter(payload => payload.event === "turn.completed" && payload.thread?.id === codexThreadId)).toHaveLength(0);
  await expect(codexTurn).toHaveAttribute("data-turn-status", "in_progress");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(codexTurn.getByText(partial.progress!.text, { exact: true })).toBeVisible();
  await capture(page, testInfo, "notification-partial-active.png");
  expect((await page.request.post("/__e2e/codex/turn-completion/release")).status()).toBe(204);
  await expect.poll(async () => (await payloads()).filter(payload => payload.event === "turn.completed" && payload.thread?.id === codexThreadId).length).toBe(1);
  expect((await payloads()).find(payload => payload.event === "turn.completed" && payload.thread?.id === codexThreadId)?.assistantResult?.partial)
    .toEqual({ text: partial.progress!.text });
});
