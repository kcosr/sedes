import { test, expect } from "./fixtures";
import {
  capture,
  createDraftThread,
  expectNoPageOverflow,
  fillAndPersistDraft,
  openSedesWorkspace,
  sendCurrentDraft,
} from "./helpers";

test("recorded turn usage appears on the Usage page with filters and thread links", async ({ page }, testInfo) => {
  await openSedesWorkspace(page);
  const threadPath = await createDraftThread(page);
  const threadId = threadPath.split("/").at(-1)!;
  await fillAndPersistDraft(page, "Summarize recorded usage");
  await sendCurrentDraft(page);
  // The scripted turn streams for several seconds, then records 11 input and 7 output tokens.
  const stop = page.getByRole("button", { name: "Stop" });
  await expect(stop).toBeVisible();
  await expect(stop).toBeHidden({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Turn usage and cost" }).last()).toBeVisible();

  const firstRead = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith("/api/usage/analytics") && response.ok());
  await page.getByTestId("desktop-sidebar").getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Usage", exact: true }).click();
  await expect(page).toHaveURL(/\/usage$/);
  await firstRead;

  // Other threads on a shared server may have usage too; scope the page to this thread.
  const view = page.getByRole("region", { name: "Usage" });
  await view.getByRole("tab", { name: "Threads" }).click();
  const threadRow = view.locator(`.usage-thread-row[data-thread-id="${threadId}"]`);
  await expect(threadRow).toContainText("18");
  await capture(page, testInfo, "usage-threads-desktop.png");
  const scoped = page.waitForResponse((response) => response.url().endsWith("/api/usage/analytics") &&
    (response.request().postDataJSON() as { filters: { thread?: string[] } }).filters.thread?.[0] === threadId);
  await threadRow.getByRole("button", { name: /^Filter to / }).click();
  await scoped;
  await expect(view.getByRole("list", { name: "Active filters" })).toContainText("Thread");

  await view.getByRole("tab", { name: "Overview" }).click();
  const tile = (label: string) => view.locator(".usage-stat").filter({ has: page.getByText(label, { exact: true }) });
  await expect(tile("Total tokens").locator(".usage-stat-value")).toHaveText("18");
  await expect(tile("Estimated cost").locator(".usage-stat-value")).toHaveText("$0.0002");
  await expect(tile("Active threads").locator(".usage-stat-value")).toHaveText("1");
  await expect(view.getByRole("group", { name: /Total tokens by model/ })).toBeVisible();
  const models = view.locator(".usage-card").filter({ has: page.getByRole("heading", { name: "Models", exact: true }) });
  await expect(models.getByText("fixture-model")).toBeVisible();
  await capture(page, testInfo, "usage-overview-desktop.png");

  const byModel = page.waitForResponse((response) => response.url().endsWith("/api/usage/analytics") &&
    (response.request().postDataJSON() as { filters: { model?: string[] } }).filters.model?.[0] === "fixture-model");
  await models.getByTitle("Filter to fixture-model").click();
  await byModel;
  await expect(view.getByRole("list", { name: "Active filters" })).toContainText("fixture-model");
  await expect(tile("Total tokens").locator(".usage-stat-value")).toHaveText("18");

  await view.getByRole("tab", { name: "Explore" }).click();
  await expect(view.getByRole("table").getByRole("row").filter({ hasText: "fixture-model" })).toContainText("18");

  await page.setViewportSize({ width: 390, height: 844 });
  await view.getByRole("tab", { name: "Overview" }).click();
  await expect(tile("Total tokens")).toBeVisible();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "usage-overview-mobile.png");

  await view.getByRole("tab", { name: "Threads" }).click();
  await threadRow.locator(".usage-thread-open").click();
  await expect(page).toHaveURL(new RegExp(`${threadPath}$`));
});
