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
  // Recorded tokens alone do not establish a live request-duration measurement.
  await expect(page.locator(".turn-throughput")).toHaveCount(0);

  const firstRead = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith("/api/usage/analytics") && response.ok());
  await page.getByTestId("desktop-sidebar").getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Usage (Experimental)", exact: true }).click();
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

test("completed turn throughput stays left aligned and survives browser reload", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openSedesWorkspace(page);
  await createDraftThread(page);
  await fillAndPersistDraft(page, "Measure turn throughput");
  expect((await page.request.post("/__e2e/pi/throughput/arm")).status()).toBe(204);
  try {
    await sendCurrentDraft(page);
    const turn = page.locator(".conversation-turn").last();
    const assistant = turn.locator('[data-item-kind="assistant_message"]');
    await expect(assistant).toContainText("Preparing the measured response.");
    await expect(assistant).toHaveAttribute("data-item-status", "streaming");
    await expect(turn).toHaveAttribute("data-turn-status", "in_progress");
    await expect(turn.locator(".turn-throughput")).toHaveCount(0);
    await expect(turn.locator("footer")).toHaveCount(0);
    await capture(page, testInfo, "turn-throughput-streaming.png");

    expect((await page.request.post("/__e2e/pi/throughput/release")).status()).toBe(204);
    await expect(assistant).toContainText("The measured response is complete.");
    await expect(turn).toHaveAttribute("data-turn-status", "completed");
    const rate = turn.locator(".turn-throughput");
    await expect(rate).toHaveText("42.3 tok/s");
    await expect(turn.getByText("42.3 tokens per second", { exact: true })).toHaveClass("sr-only");
    const accessibleFooter = await turn.locator("footer").ariaSnapshot();
    expect(accessibleFooter.match(/42\.3 tokens per second/g)).toHaveLength(1);
    expect(accessibleFooter).not.toContain("42.3 tok/s");
    await expect(turn.locator("footer")).not.toContainText(/elapsed|10(?:\.0)?\s*(?:s\b|seconds)/i);

    for (const viewport of [
      { width: 1280, height: 720, name: "desktop" },
      { width: 390, height: 844, name: "mobile" },
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await rate.scrollIntoViewIfNeeded();
      await expect(rate).toBeVisible();
      await expect.poll(() => turn.locator("footer").evaluate((footer) => {
        const rate = footer.querySelector<HTMLElement>(".turn-throughput")!;
        const controls = footer.querySelector<HTMLElement>(".turn-fork-controls")!;
        const bounds = footer.getBoundingClientRect();
        const rateBounds = rate.getBoundingClientRect();
        const controlsBounds = controls.getBoundingClientRect();
        const textBounds = footer.closest(".conversation-turn")!
          .querySelector('[data-item-kind="assistant_message"] .markdown')!
          .getBoundingClientRect();
        const style = getComputedStyle(footer);
        return Math.abs(rateBounds.left - bounds.left - Number.parseFloat(style.paddingLeft)) <= 1 &&
          Math.abs(rateBounds.left - textBounds.left) <= 1 &&
          Math.abs(controlsBounds.right - bounds.right + Number.parseFloat(style.paddingRight)) <= 1 &&
          rateBounds.right < controlsBounds.left &&
          Math.abs(rateBounds.top + rateBounds.height / 2 - controlsBounds.top - controlsBounds.height / 2) <= 3;
      })).toBe(true);
      await expectNoPageOverflow(page);
      await capture(page, testInfo, `turn-throughput-${viewport.name}.png`);
    }

    // Reload reconnects to the same resident runtime and must retain its
    // observation without consulting the separate durable usage report.
    await page.reload();
    await expect(page.locator(".turn-throughput")).toHaveText("42.3 tok/s");
    await expect(page.locator(".conversation-turn").last()).toHaveAttribute("data-turn-status", "completed");
  } finally {
    await page.request.post("/__e2e/pi/throughput/release");
  }
});
