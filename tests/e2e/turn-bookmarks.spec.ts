import { expect, test } from "./fixtures";
import {
  capture,
  createDraftThread,
  expectNoPageOverflow,
  fillAndPersistDraft,
  openSedesWorkspace,
  sendCurrentDraft,
} from "./helpers";

test("turn bookmarks persist, preview both sides, navigate, and synchronize", async ({
  browser,
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openSedesWorkspace(page);
  const threadPath = await createDraftThread(page);

  const prompts = [
    "Bookmark the durable identity design",
    "Keep this later turn visible while navigating",
  ];
  for (const [index, prompt] of prompts.entries()) {
    await fillAndPersistDraft(page, prompt);
    if (index === 0) {
      expect((await page.request.post("/__e2e/pi/bookmark/arm")).status()).toBe(204);
      try {
        await sendCurrentDraft(page);
        const activeTurn = page.locator('.conversation-turn[data-turn-status="in_progress"]');
        await expect(activeTurn.locator('[data-item-kind="user_message"]')).toBeVisible();
        await expect(activeTurn.locator('[data-item-kind="assistant_message"]')).toContainText("I found", { timeout: 12_000 });
        await activeTurn.getByRole("button", { name: "Bookmark turn" }).click();
        await expect(activeTurn.getByRole("button", { name: "Remove turn bookmark" })).toBeEnabled();
        await page.getByRole("button", { name: "Bookmarks, 1" }).click();
        await expect(page.locator(".turn-bookmark-assistant-preview")).toContainText("I found");
        await expect(page.locator(".turn-bookmark-assistant-preview")).not.toContainText("deterministic normalized result");
        await capture(page, testInfo, "turn-bookmarks-streaming.png");
        await page.keyboard.press("Escape");
      } finally {
        expect((await page.request.post("/__e2e/pi/bookmark/release")).status()).toBe(204);
      }
    } else {
      await sendCurrentDraft(page);
    }
    await expect(
      page.locator('.conversation-turn[data-turn-status="completed"]'),
    ).toHaveCount(index + 1, { timeout: 15_000 });
    if (index === 0) {
      await page.getByRole("button", { name: "Bookmarks, 1" }).click();
      await expect(page.locator(".turn-bookmark-assistant-preview")).toContainText(
        `deterministic normalized result for ${prompt}`,
      );
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Remove turn bookmark" }).click();
      await expect(page.getByRole("button", { name: "Bookmarks", exact: true })).toBeVisible();
    }
  }

  const completedTurns = page.locator(
    '.conversation-turn[data-turn-status="completed"]',
  );
  const firstTurn = completedTurns.first();
  const firstTurnId = await firstTurn.getAttribute("data-turn-id");
  expect(firstTurnId).toBeTruthy();
  await expect(
    firstTurn.locator(
      '[data-item-kind="assistant_message"][data-item-status="completed"]',
    ),
  ).toContainText("deterministic normalized result");

  // Keep a second live client open before mutation so the assertion below
  // proves application-state publication rather than bootstrap persistence.
  const peer = await page.context().newPage();
  await peer.goto(threadPath);
  await expect(
    peer.getByRole("textbox", { name: "Message Scripted agent" }),
  ).toBeVisible();
  const peerFirstTurn = peer
    .locator('.conversation-turn[data-turn-status="completed"]')
    .first();
  await expect(
    peerFirstTurn.getByRole("button", { name: "Bookmark turn" }),
  ).toBeEnabled();
  const selectedDesktopThread = page
    .getByTestId("desktop-sidebar")
    .locator('[data-testid="thread-row"][data-selected="true"]');
  const desktopBookmarkIndicator = selectedDesktopThread.locator(
    '[data-chip="bookmarks"]',
  );
  await expect(desktopBookmarkIndicator).toHaveCount(0);

  await firstTurn.hover();
  const bookmarkToggle = firstTurn.getByRole("button", {
    name: "Bookmark turn",
  });
  await expect(bookmarkToggle).toBeEnabled();
  await bookmarkToggle.click();
  await expect(
    firstTurn.getByRole("button", { name: "Remove turn bookmark" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Bookmarks, 1" }),
  ).toBeVisible();
  await expect(desktopBookmarkIndicator).toHaveAccessibleName(
    "1 bookmarked turn",
  );
  await expect(
    desktopBookmarkIndicator.locator(".status-chip-count"),
  ).toHaveCount(0);

  await expect(peer.getByRole("button", { name: "Bookmarks, 1" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    peerFirstTurn.getByRole("button", { name: "Remove turn bookmark" }),
  ).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Bookmarks, 1" }).click();
  const desktopBookmarks = page.locator(".turn-bookmarks-popover");
  await expect(desktopBookmarks).toBeVisible();
  await expect(
    desktopBookmarks.locator(".turn-bookmark-user-preview"),
  ).toContainText(prompts[0]!);
  await expect(
    desktopBookmarks.locator(".turn-bookmark-assistant-preview"),
  ).toContainText(`deterministic normalized result for ${prompts[0]}`);
  await capture(page, testInfo, "turn-bookmarks-desktop-populated.png");

  await desktopBookmarks.locator(".turn-bookmark-link").click();
  await expect(page).toHaveURL(
    new RegExp(
      `${threadPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    ),
  );
  await expect(page.locator(".source-turn-highlight")).toHaveAttribute(
    "data-turn-id",
    firstTurnId!,
  );
  await expect(page.locator(".source-turn-highlight")).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Return to latest" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Message Scripted agent" }),
  ).toBeEnabled();
  await page.getByTestId("thread-target-context").click();
  await expect(page.locator(".source-turn-highlight")).toHaveCount(0);

  await page.reload();
  await expect(
    page.getByRole("button", { name: "Bookmarks, 1" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Bookmarks, 1" }).click();
  await expect(page.locator(".turn-bookmark-user-preview")).toContainText(
    prompts[0]!,
  );
  await page.keyboard.press("Escape");

  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const mobilePage = await mobileContext.newPage();
  await mobilePage.goto(threadPath);
  await mobilePage
    .getByRole("button", { name: "Open thread navigation" })
    .click();
  const mobileNavigation = mobilePage.getByRole("dialog", {
    name: "Thread navigation",
  });
  const selectedMobileThread = mobileNavigation.locator(
    '[data-selected="true"]',
  );
  await expect(selectedMobileThread).toBeVisible();
  await expect(
    selectedMobileThread.getByRole("img", { name: "1 bookmarked turn" }),
  ).toBeVisible();
  await expect(
    selectedMobileThread.locator(
      ".flat-row-bookmark-indicator .flat-row-indicator-count",
    ),
  ).toHaveCount(0);
  await mobilePage.keyboard.press("Escape");
  const mobileTrigger = mobilePage.getByRole("button", {
    name: "Bookmarks, 1",
  });
  await expect(mobileTrigger).toBeVisible();
  await mobileTrigger.click();
  const dialog = mobilePage.getByRole("dialog", { name: "Bookmarks" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".turn-bookmark-user-preview")).toContainText(
    prompts[0]!,
  );
  await expect(
    dialog.locator(".turn-bookmark-assistant-preview"),
  ).toContainText("deterministic normalized result");
  const [dialogBox, linkBox, removeBox] = await Promise.all([
    dialog.boundingBox(),
    dialog.locator(".turn-bookmark-link").boundingBox(),
    dialog
      .getByRole("button", { name: `Remove bookmark: ${prompts[0]}` })
      .boundingBox(),
  ]);
  expect(dialogBox).not.toBeNull();
  expect(dialogBox!.width).toBeLessThanOrEqual(390);
  expect(linkBox).not.toBeNull();
  expect(linkBox!.height).toBeGreaterThanOrEqual(44);
  expect(removeBox).not.toBeNull();
  expect(removeBox!.width).toBeGreaterThanOrEqual(44);
  expect(removeBox!.height).toBeGreaterThanOrEqual(44);
  await expectNoPageOverflow(mobilePage);
  await capture(mobilePage, testInfo, "turn-bookmarks-mobile-sheet.png");

  await dialog.locator(".turn-bookmark-link").click();
  await expect(dialog).toBeHidden();
  await expect(mobilePage).toHaveURL(
    new RegExp(
      `${threadPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    ),
  );
  await expect(mobilePage.locator(".source-turn-highlight")).toHaveAttribute(
    "data-turn-id",
    firstTurnId!,
  );
  await expect(mobilePage.locator(".source-turn-highlight")).toBeFocused();
  await mobilePage.getByTestId("thread-context").click();
  await expect(mobilePage.locator(".source-turn-highlight")).toHaveCount(0);

  await mobileTrigger.click();
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: `Remove bookmark: ${prompts[0]}` })
    .click();
  await expect(dialog).toContainText(
    "Bookmark a user message to find that turn here.",
  );
  await mobilePage.keyboard.press("Escape");
  await expect(
    mobilePage.getByRole("button", { name: "Bookmarks", exact: true }),
  ).toBeVisible();
  await expect(
    peer.getByRole("button", { name: "Bookmarks", exact: true }),
  ).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    peerFirstTurn.getByRole("button", { name: "Bookmark turn" }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(desktopBookmarkIndicator).toHaveCount(0);
  await mobilePage
    .getByRole("button", { name: "Open thread navigation" })
    .click();
  await expect(selectedMobileThread).toBeVisible();
  await expect(
    selectedMobileThread.getByRole("img", { name: /bookmarked turn/ }),
  ).toHaveCount(0);
  await mobilePage.keyboard.press("Escape");

  await mobilePage.reload();
  await expect(
    mobilePage.getByRole("button", { name: "Bookmarks", exact: true }),
  ).toBeVisible();
  await mobilePage
    .getByRole("button", { name: "Bookmarks", exact: true })
    .click();
  await expect(
    mobilePage.getByRole("dialog", { name: "Bookmarks" }),
  ).toContainText("Bookmark a user message to find that turn here.");
  await mobileContext.close();
  await peer.close();
});
