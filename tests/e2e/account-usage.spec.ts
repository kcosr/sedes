import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import type { BackendAccountUsage } from "../../src/shared/protocol/account-usage.js";
import { test, expect } from "./fixtures";
import { createCodexThread } from "./automatic-model-retry-helpers";
import {
  capture,
  createDraftThread,
  expectNoPageOverflow,
  fillAndPersistDraft,
  openWorkspaceDirectory,
  sendCurrentDraft,
} from "./helpers";
import { loadE2ERunContext } from "./run-context";

async function publishUsage(page: Page, usage: BackendAccountUsage | null): Promise<void> {
  const response = await page.request.post("/__e2e/codex/account-usage", { data: { usage } });
  expect(response.status(), await response.text()).toBe(204);
}

function weekly(remainingPercent = 28): BackendAccountUsage {
  const capturedAt = Date.now();
  return {
    capturedAt,
    accountId: "example-codex-account",
    plan: "Pro Max",
    includedUsageAllowed: true,
    windows: [{ remainingPercent, durationMinutes: 10_080, resetsAt: capturedAt + 3 * 86_400_000 }],
  };
}

test("account quota stays scoped, opens deliberately, and works by touch", async ({ page, browser }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const directory = path.join(loadE2ERunContext().workspacesDirectory, "account-usage");
  await mkdir(directory, { recursive: true });
  await publishUsage(page, null);
  const mobileContext = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    await openWorkspaceDirectory(page, directory);
    const threadId = await createCodexThread(page, "Review the usage indicator");
    const threadPath = `/threads/${threadId}`;
    const line = page.locator(".account-usage-line");
    const popover = page.getByRole("dialog", { name: /^Codex.* included usage$/ });
    await expect(line).toHaveCount(0);

    await publishUsage(page, weekly());
    await expect(line).toHaveAccessibleName(/^Codex.* included usage: 28% remaining\. Show usage details\.$/);
    await fillAndPersistDraft(page, "Review the recent changes and suggest the next step.", "Message Codex");
    await capture(page, testInfo, "account-usage-desktop-line.png");

    const box = await line.boundingBox();
    expect(box).not.toBeNull();
    const y = box!.y + box!.height / 2;
    const left = box!.x + box!.width * 0.3;
    const right = box!.x + box!.width * 0.7;
    await page.mouse.move(left, y);
    // Exercise the actual deliberate-hover delay, then leave before it opens.
    await page.waitForTimeout(200);
    await expect(popover).toHaveCount(0);
    await page.mouse.move(left, box!.y - 30);
    await page.waitForTimeout(400);
    await expect(popover).toHaveCount(0);
    await page.mouse.move(left, y);
    await expect(popover).toBeVisible();
    await expect(popover.getByText("Weekly", { exact: true })).toBeVisible();
    await expect(popover.getByText("28% left", { exact: true })).toBeVisible();
    await expect(popover.getByText("5-hour", { exact: true })).toHaveCount(0);
    await expect.poll(async () => {
      const popup = await popover.boundingBox();
      return Math.abs(popup!.x + popup!.width / 2 - left);
    }).toBeLessThan(3);
    await page.mouse.move(right, y);
    await expect.poll(async () => {
      const popup = await popover.boundingBox();
      return Math.abs(popup!.x + popup!.width / 2 - right);
    }).toBeLessThan(3);
    const popupBox = await popover.boundingBox();
    expect(popupBox!.y + popupBox!.height).toBeLessThan(box!.y + 1);
    await capture(page, testInfo, "account-usage-desktop-popover.png");

    // Entering the popover keeps it open; clicking the line pins its position.
    await page.mouse.move(popupBox!.x + 30, popupBox!.y + 30);
    await expect(popover).toBeVisible();
    await line.click({ position: { x: box!.width * 0.7, y: box!.height / 2 } });
    await page.mouse.move(left, box!.y - 30);
    await expect(popover).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await page.getByRole("textbox", { name: "Message Codex" }).focus();
    await line.focus();
    await expect(popover).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);

    expect((await page.request.post("/__e2e/codex/turn-completion/arm")).status()).toBe(204);
    await sendCurrentDraft(page);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await expect(page.locator(".input-activity-bar")).toBeVisible();
    await expect(line).toBeVisible();
    // The held turn is executing its tool; final assistant text arrives only
    // after release. Capture the visible working state with both lines present.
    await expect(page.getByRole("button", { name: /Activity.*1 tool call.*Working/ })).toBeVisible();
    await capture(page, testInfo, "account-usage-desktop-streaming.png", { animations: "allow" });
    expect((await page.request.post("/__e2e/codex/turn-completion/release")).status()).toBe(204);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();

    const mobile = await mobileContext.newPage();
    const mobileErrors: string[] = [];
    mobile.on("pageerror", error => mobileErrors.push(error.message));
    await mobile.goto(threadPath);
    const mobileLine = mobile.locator(".account-usage-line");
    const mobilePopover = mobile.getByRole("dialog", { name: /^Codex.* included usage$/ });
    await expect(mobileLine).toBeVisible();
    expect((await mobileLine.boundingBox())!.height).toBeGreaterThanOrEqual(16);
    await mobileLine.tap();
    await expect(mobilePopover).toBeVisible();
    await expectNoPageOverflow(mobile);
    const mobileBox = await mobilePopover.boundingBox();
    expect(mobileBox!.x).toBeGreaterThanOrEqual(0);
    expect(mobileBox!.x + mobileBox!.width).toBeLessThanOrEqual(390);
    await capture(mobile, testInfo, "account-usage-mobile-popover.png");

    // A failed read removes both the line and an already open popover everywhere.
    await publishUsage(page, null);
    await expect(line).toHaveCount(0);
    await expect(mobileLine).toHaveCount(0);
    await expect(mobilePopover).toHaveCount(0);
    await publishUsage(page, { ...weekly(0), includedUsageAllowed: false });
    await expect(mobileLine).toHaveAccessibleName(/^Codex.* included usage: 0% remaining\. Show usage details\.$/);
    await mobileLine.tap();
    await expect(mobilePopover.getByText("0% left", { exact: true })).toBeVisible();
    await expect(mobilePopover.getByText("Included usage is currently unavailable.", { exact: true })).toBeVisible();
    await capture(mobile, testInfo, "account-usage-mobile-zero.png");

    // Cached data belongs only to its backend; opening a Pi composer cannot use it.
    await createDraftThread(page, "A different backend");
    await expect(line).toHaveCount(0);
    await page.goto(threadPath);
    await expect(line).toBeVisible();
    await publishUsage(page, { ...weekly(), capturedAt: Date.now() - 11 * 60_000 });
    await expect(line).toHaveCount(0);
    await expect(mobileLine).toHaveCount(0);
    await publishUsage(page, { ...weekly(), windows: [{ remainingPercent: 28, durationMinutes: 10_080, resetsAt: Date.now() - 1_000 }] });
    await expect(line).toHaveCount(0);
    expect(mobileErrors).toEqual([]);
  } finally {
    await mobileContext.close();
    await publishUsage(page, null);
    await page.request.post("/__e2e/codex/turn-completion/reset");
  }
});
