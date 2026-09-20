import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  capture,
  fillAndPersistDraft,
  openSedesWorkspace,
  selectCustomNewThreadTarget,
  sendCurrentDraft,
} from "./helpers";

async function createNamedPiThread(page: Page, title: string): Promise<string> {
  const previousPath = new URL(page.url()).pathname;
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/threads") &&
      response.status() === 201,
  );
  await page
    .getByTestId("desktop-sidebar")
    .getByTestId("new-thread-trigger")
    .click();
  const titleInput = page.getByRole("textbox", { name: "Thread name" });
  await expect(titleInput).toBeVisible();
  await titleInput.fill(title);
  await selectCustomNewThreadTarget(page, "Pi SDK");
  await page.getByRole("button", { name: "Create thread" }).click();
  await created;
  await expect(page).toHaveURL(url =>
    url.pathname !== previousPath && /^\/threads\/[0-9a-f-]+$/.test(url.pathname),
  );
  return new URL(page.url()).pathname;
}

test("agent sends and callbacks render as collapsed attributed disclosures", async ({
  page,
}, testInfo) => {
  await openSedesWorkspace(page);

  const callerPath = await createNamedPiThread(page, "Callback caller");
  const callerThreadId = callerPath.split("/").at(-1);
  expect(callerThreadId).toBeTruthy();
  await fillAndPersistDraft(page, "Bind and settle the callback caller.");
  await sendCurrentDraft(page);
  const completedAssistantMessages = page.locator(
    '[data-item-kind="assistant_message"][data-item-status="completed"]',
  );
  await expect(completedAssistantMessages).toHaveCount(1, {
    timeout: 20_000,
  });

  const targetPath = await createNamedPiThread(page, "Callback worker");
  const targetThreadId = targetPath.split("/").at(-1);
  expect(targetThreadId).toBeTruthy();

  const callbackSend = await page.request.post(
    `/__e2e/agent-completion-callbacks/send/${callerThreadId}/${targetThreadId}`,
  );
  expect(callbackSend.status()).toBe(202);
  expect(await callbackSend.json()).toMatchObject({
    status: "delivery_accepted",
    operationId: expect.any(String),
    callbackId: expect.any(String),
  });

  await page.goto(targetPath);
  const agentMessage = page.locator(
    '[data-item-kind="user_message"] [data-message-origin="agent_message"], [data-item-kind="user_message"][data-message-origin="agent_message"]',
  );
  await expect(agentMessage).toHaveCount(1, { timeout: 20_000 });
  await expect(agentMessage).not.toHaveAttribute("open", "");
  await expect(agentMessage.locator("summary")).toContainText("Agent message");
  await expect(agentMessage.locator("summary")).toContainText("Callback caller");
  await expect(agentMessage.locator("summary")).toContainText(
    "Complete the callback E2E task and report the result.",
  );

  await page.goto(callerPath);
  const callbackMessage = page.locator(
    '[data-item-kind="user_message"] [data-message-origin="agent_result"], [data-item-kind="user_message"][data-message-origin="agent_result"]',
  );
  await expect(callbackMessage).toHaveCount(1, { timeout: 20_000 });
  await expect(callbackMessage).not.toHaveAttribute("open", "");
  await expect(callbackMessage.locator("summary")).toContainText("Agent result");
  await expect(callbackMessage.locator("summary")).toContainText(
    "Callback worker",
  );
  await expect(
    callbackMessage.locator(".agent-input-disclosure-preview"),
  ).not.toBeEmpty();
  await expect(
    callbackMessage.getByText("You", { exact: true }),
  ).toHaveCount(0);
  await expect(completedAssistantMessages).toHaveCount(2, {
    timeout: 20_000,
  });
  await callbackMessage.scrollIntoViewIfNeeded();
  await capture(page, testInfo, "agent-completion-callback-idle.png");
});
