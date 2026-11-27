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
  selectCustomNewThreadTarget,
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
    windows: [{ scope: { kind: "account" }, remainingPercent, durationMinutes: 10_080, resetsAt: capturedAt + 3 * 86_400_000 }],
  };
}

async function createClaudeDraft(page: Page, title: string): Promise<string> {
  const created = page.waitForResponse(response => response.request().method() === "POST"
    && response.url().endsWith("/api/threads") && response.status() === 201);
  await page.getByTestId("desktop-sidebar").getByTestId("new-thread-trigger").click();
  await selectCustomNewThreadTarget(page, "Claude subscription · Claude");
  await page.getByRole("textbox", { name: "Thread name" }).fill(title);
  await page.getByRole("button", { name: "Create thread" }).click();
  const { threadId } = await (await created).json() as { threadId: string };
  const threadPath = `/threads/${threadId}`;
  await expect(page).toHaveURL(url => url.pathname === threadPath);
  await expect(page.getByRole("textbox", { name: "Message Claude" })).toBeVisible();
  return threadPath;
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
    await publishUsage(page, { ...weekly(), windows: [{ scope: { kind: "account" }, remainingPercent: 28, durationMinutes: 10_080, resetsAt: Date.now() - 1_000 }] });
    await expect(line).toHaveCount(0);
    expect(mobileErrors).toEqual([]);
  } finally {
    await mobileContext.close();
    await publishUsage(page, null);
    await page.request.post("/__e2e/codex/turn-completion/reset");
  }
});

test("Claude quota follows the model selected for the next turn", async ({ page, browser }, testInfo) => {
  const directory = path.join(loadE2ERunContext().workspacesDirectory, "claude-account-usage");
  await mkdir(directory, { recursive: true });
  await openWorkspaceDirectory(page, directory);
  const threadPath = await createClaudeDraft(page, "Claude quota");
  const composer = page.getByTestId("composer");
  const model = composer.getByRole("combobox", { name: "Model" });
  await expect(model).toContainText("Claude Sonnet 5");

  // Binding the real Claude driver starts the first observation from the offline SDK.
  await fillAndPersistDraft(page, "/review quota", "Message Claude");
  await sendCurrentDraft(page);
  await expect(page.getByText("Claude completed the selected review skill as an ordinary model turn.")).toBeVisible();
  const line = composer.locator(".account-usage-line");
  const card = page.getByRole("dialog", { name: /^Claude.* included usage$/ });
  await expect(line).toHaveAccessibleName(/Weekly · All models, 47% remaining/);
  await line.hover();
  const rows = card.locator(".account-usage-window");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Weekly · All models");
  await expect(rows.first()).toContainText("47% left");
  const checked = await card.locator(".account-usage-checked time").getAttribute("datetime");
  await page.keyboard.press("Escape");

  await model.click();
  await page.getByRole("option", { name: "Claude Fable 5.2", exact: true }).click();
  await expect(line).toHaveAccessibleName(/Weekly · Fable, 35% remaining/);
  await expect(composer.locator(".account-usage-line")).toHaveCount(1);
  await expect(composer).not.toContainText(/\d+% left/);
  await line.focus();
  await expect(rows.first()).toContainText("Weekly · Fable");
  await expect(rows.first()).toContainText("35% left");
  await expect(rows.nth(1)).toContainText("Weekly · All models");
  await expect(card.locator(".account-usage-checked time")).toHaveAttribute("datetime", checked!);
  await capture(page, testInfo, "account-usage-claude-fable.png");

  const mobile = await browser.newPage({
    baseURL: process.env.E2E_BASE_URL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  });
  try {
    await mobile.goto(threadPath);
    await mobile.getByRole("button", { name: /Weekly · Fable, 35% remaining/ }).tap();
    const mobileCard = mobile.getByRole("dialog", { name: /^Claude.* included usage$/ });
    await expect(mobileCard.locator(".account-usage-window").first()).toContainText("Weekly · Fable");
    await expect(mobileCard.getByText("47% left", { exact: true })).toBeVisible();
    await expectNoPageOverflow(mobile);
    await capture(mobile, testInfo, "account-usage-claude-fable-mobile.png");
    // This draft targets the same backend but has no verified conversation.
    await createClaudeDraft(page, "Unbound Claude draft");
    await expect(page.locator(".account-usage-line")).toHaveCount(0);
    await expect(mobileCard.getByText("35% left", { exact: true })).toBeVisible();
  } finally {
    await mobile.close();
  }
});
