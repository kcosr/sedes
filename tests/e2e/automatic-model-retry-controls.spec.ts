import { test, expect } from "./fixtures";
import { capture, fillAndPersistDraft, openSedesWorkspace, sendCurrentDraft } from "./helpers";
import { armFailures, createCodexThread, retryNotice, setAutomaticRetry, type RecordedTurn } from "./automatic-model-retry-helpers";

test("disabled retry, Stop, and a new ordinary message prevent the delayed automatic follow-up", async ({ page }, testInfo) => {
  await page.goto("/");
  await openSedesWorkspace(page);
  await setAutomaticRetry(page, false);
  const disabledId = await createCodexThread(page, "Automatic recovery disabled");
  await armFailures(page, 1);
  await fillAndPersistDraft(page, "Fail while automatic retry is disabled", "Message Codex");
  await sendCurrentDraft(page);
  const disabledRow = page.getByTestId("desktop-sidebar").locator(`[data-thread-drop-id="${disabledId}"]`);
  await expect(disabledRow.locator('[data-chip="failed"]')).toBeVisible();
  await expect(page.getByText(retryNotice, { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-message-origin="automatic_retry"]')).toHaveCount(0);

  await setAutomaticRetry(page, true);
  const stoppedId = await createCodexThread(page, "Automatic recovery stopped");
  await armFailures(page, 1);
  await fillAndPersistDraft(page, "Cancel the delayed automatic follow-up", "Message Codex");
  await sendCurrentDraft(page);
  await expect(page.getByText(retryNotice, { exact: true })).toBeVisible();
  const stopped = page.waitForResponse(response => response.request().method() === "POST" &&
    response.url().endsWith("/operations") && response.request().postDataJSON().kind === "interrupt" && response.ok());
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await stopped;
  await expect(page.getByText(retryNotice, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
  const stoppedRow = page.getByTestId("desktop-sidebar").locator(`[data-thread-drop-id="${stoppedId}"]`);
  await expect(stoppedRow.locator('[data-chip="failed"]')).toBeVisible();
  await capture(page, testInfo, "automatic-retry-stopped.png");

  const replacedId = await createCodexThread(page, "Automatic recovery replaced by user");
  await armFailures(page, 1);
  const failedText = "Fail before I supply new ordinary input";
  const replacementText = "Use my new instructions instead of the automatic follow-up";
  await fillAndPersistDraft(page, failedText, "Message Codex");
  await sendCurrentDraft(page);
  await expect(page.getByText(retryNotice, { exact: true })).toBeVisible();
  await fillAndPersistDraft(page, replacementText, "Message Codex");
  // Starting is only a retry presentation. The failed provider turn can accept
  // ordinary Submit, and drafting alone must keep the pending retry intact.
  await expect(page.getByText(retryNotice, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  await capture(page, testInfo, "automatic-retry-user-message-ready.png");
  const delivered = page.waitForResponse(response => response.request().method() === "POST" &&
    response.url().endsWith("/operations") && response.request().postDataJSON().kind === "deliver" && response.ok());
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  expect((await delivered).request().postDataJSON()).toMatchObject({ kind: "deliver", mode: "submit" });
  await expect(page.getByText(retryNotice, { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-item-kind="user_message"]:not([data-client-provisional="true"])')
    .filter({ hasText: replacementText })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('[data-message-origin="automatic_retry"]')).toHaveCount(0);

  const [disabled, stopResult, replaced] = await Promise.all([
    page.request.get(`/__e2e/codex/model-failure/observe/${disabledId}`),
    page.request.get(`/__e2e/codex/model-failure/observe/${stoppedId}`),
    page.request.get(`/__e2e/codex/model-failure/observe/${replacedId}`)]);
  expect(disabled.ok()).toBe(true);
  expect(stopResult.ok()).toBe(true);
  expect(replaced.ok()).toBe(true);
  expect(((await disabled.json()) as { turns: RecordedTurn[] }).turns.map(turn => turn.text)).toEqual([
    "Fail while automatic retry is disabled",
  ]);
  expect(((await stopResult.json()) as { turns: RecordedTurn[] }).turns.map(turn => turn.text)).toEqual([
    "Cancel the delayed automatic follow-up",
  ]);
  expect(((await replaced.json()) as { turns: RecordedTurn[] }).turns.map(turn => turn.text)).toEqual([
    failedText, replacementText,
  ]);
  await expect(page.locator('[data-message-origin="automatic_retry"]')).toHaveCount(0);
});
