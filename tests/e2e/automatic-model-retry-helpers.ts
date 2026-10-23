import type { Page } from "@playwright/test";
import { expect } from "./fixtures";
import { openSettingsPage, returnFromSettings, selectCustomNewThreadTarget } from "./helpers";

export const continueText = "Please continue from where you left off.";
export const retryNotice = "Retrying in 10 seconds…";
export interface RecordedTurn { turnId: string; text: string; startedAt: number; failedAt?: number }

export async function createCodexThread(page: Page, title: string): Promise<string> {
  await page.getByTestId("desktop-sidebar").getByTestId("new-thread-trigger").click();
  await selectCustomNewThreadTarget(page, "Codex TCP external · Codex TCP");
  await page.getByRole("textbox", { name: "Thread name" }).fill(title);
  const created = page.waitForResponse(response => response.request().method() === "POST" &&
    response.url().endsWith("/api/threads") && response.status() === 201);
  await page.getByRole("button", { name: "Create thread" }).click();
  await created;
  await expect(page.getByRole("textbox", { name: "Message Codex" })).toBeVisible();
  return new URL(page.url()).pathname.split("/").at(-1)!;
}

export async function armFailures(page: Page, count: number): Promise<void> {
  expect((await page.request.post("/__e2e/codex/model-failure/arm", { data: { count } })).status()).toBe(204);
}

export async function turns(page: Page, threadId: string): Promise<RecordedTurn[]> {
  const response = await page.request.get(`/__e2e/codex/model-failure/state/${threadId}`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { turns: RecordedTurn[] }).turns;
}

export async function setAutomaticRetry(page: Page, enabled: boolean): Promise<void> {
  await openSettingsPage(page, "general");
  const toggle = page.getByTestId("auto-retry-model-failures-toggle");
  await expect(toggle).toBeEnabled();
  if ((await toggle.getAttribute("data-state")) !== (enabled ? "checked" : "unchecked")) {
    const saved = page.waitForResponse(response => response.request().method() === "PUT" &&
      response.url().endsWith("/api/application/preferences") && response.ok());
    await toggle.click();
    await saved;
  }
  await expect(toggle).toHaveAttribute("data-state", enabled ? "checked" : "unchecked");
  await returnFromSettings(page);
}
