import { test, expect } from "./fixtures";
import { capture, fillAndPersistDraft, openSedesWorkspace, sendCurrentDraft } from "./helpers";
import { armFailures, continueText, createCodexThread, retryNotice, setAutomaticRetry, turns, type RecordedTurn } from "./automatic-model-retry-helpers";

test("failed model turns send a visible follow-up, reset after success, and stop after a consecutive retry failure", async ({ page }, testInfo) => {
  await page.goto("/");
  await openSedesWorkspace(page);
  await setAutomaticRetry(page, true);
  const threadId = await createCodexThread(page, "Automatic recovery lifecycle");
  await armFailures(page, 1);
  const original = "Recover a confirmed inference-output decoding failure";
  await fillAndPersistDraft(page, original, "Message Codex");
  await sendCurrentDraft(page);
  const notice = page.getByText(retryNotice, { exact: true });
  await expect(notice).toBeVisible();
  const row = page.getByTestId("desktop-sidebar").locator(`[data-thread-drop-id="${threadId}"]`);
  await expect(row.getByTestId("run-indicator")).toHaveAttribute("data-state", "starting");
  await expect(row.locator('[data-chip="failed"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await capture(page, testInfo, "automatic-retry-pending.png");

  const automatic = page.locator('[data-message-origin="automatic_retry"]');
  await expect(automatic).toHaveCount(1, { timeout: 15_000 });
  await expect(automatic.getByText("Automatic retry", { exact: true })).toBeVisible();
  await expect(automatic.locator(".agent-input-disclosure-preview")).toHaveText(continueText);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await capture(page, testInfo, "automatic-retry-running.png");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('[data-item-kind="assistant_message"][data-item-status="completed"]')).toContainText(
    "Codex is streaming a browser-neutral normalized response.");
  await expect(notice).toHaveCount(0);
  const recovered = await turns(page, threadId);
  expect(recovered.map(turn => turn.text)).toEqual([original, continueText]);
  expect(recovered[1]!.startedAt - recovered[0]!.failedAt!).toBeGreaterThanOrEqual(10_000);
  await capture(page, testInfo, "automatic-retry-success.png");

  // A later user input is a new occurrence. This time both confirmed model
  // responses fail, so only one ordinary follow-up is allowed.
  await armFailures(page, 2);
  const later = "Fail again after the successful model feedback";
  await fillAndPersistDraft(page, later, "Message Codex");
  await sendCurrentDraft(page);
  await expect(notice).toBeVisible();
  await expect(automatic).toHaveCount(2, { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
  await expect(row.locator('[data-chip="failed"]')).toBeVisible();
  await expect(notice).toHaveCount(0);
  // The fixture observes a full real retry interval. A second automatic Send
  // would change its recorded count; no shortened production delay is used.
  const quiet = await page.request.get(`/__e2e/codex/model-failure/observe/${threadId}`);
  expect(quiet.ok()).toBe(true);
  const exhausted = ((await quiet.json()) as { turns: RecordedTurn[] }).turns;
  expect(exhausted.map(turn => turn.text)).toEqual([original, continueText, later, continueText]);
  expect(exhausted[3]!.startedAt - exhausted[2]!.failedAt!).toBeGreaterThanOrEqual(10_000);
  await page.reload();
  await expect(page.locator('[data-message-origin="automatic_retry"]')).toHaveCount(2);
  await expect(page.getByText(retryNotice, { exact: true })).toHaveCount(0);
});
