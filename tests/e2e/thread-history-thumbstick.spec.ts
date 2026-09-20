import { expect, test } from "./fixtures";
import {
  capture,
  createDraftThread,
  expectNoPageOverflow,
  fillAndPersistDraft,
  openSedesWorkspace,
  sendCurrentDraft,
} from "./helpers";

test("mobile history thumbstick directly scrubs previews and seeks on release", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openSedesWorkspace(page);
  await createDraftThread(page);

  const prompts = [
    "Earlier mobile history checkpoint",
    "Latest mobile history checkpoint",
    "Newest mobile history checkpoint",
  ];
  const scanner = page.getByRole("button", {
    name: "Tap to jump to the latest user message; hold to scrub conversation history",
  });
  for (const [index, prompt] of prompts.entries()) {
    const previousUserCount = await page
      .locator('[data-item-kind="user_message"]')
      .count();
    await fillAndPersistDraft(page, prompt);
    await sendCurrentDraft(page);
    await expect(page.locator('[data-item-kind="user_message"]')).toHaveCount(
      previousUserCount + 1,
    );
    // Durable steer admission keeps composer controls usable during an active
    // run, so button visibility is not settlement evidence. Wait for the
    // authoritative turn boundary before inspecting its fork/footer state.
    await expect(
      page.locator('.conversation-turn[data-turn-status="completed"]'),
    ).toHaveCount(index + 1, { timeout: 15_000 });

    if (index === 0) {
      const latestFooter = page
        .locator('[data-turn-status="completed"]')
        .last()
        .locator(".turn-fork-controls");
      await expect(latestFooter).toHaveCSS("opacity", "1");

      await page.setViewportSize({ width: 390, height: 844 });
      await expect(scanner).toBeVisible();
      const singletonBox = await scanner.boundingBox();
      expect(singletonBox).not.toBeNull();
      await page.mouse.move(
        singletonBox!.x + singletonBox!.width / 2,
        singletonBox!.y + singletonBox!.height / 2,
      );
      await page.mouse.down();
      await page.waitForTimeout(280);
      await expect(
        page.locator(".mobile-chat-history-thumbstick-preview"),
      ).toContainText("Message 1 of 1");
      await page.mouse.up();
      const jumpToLatest = page.getByRole("button", {
        name: "Jump to latest",
      });
      await expect(jumpToLatest).toBeVisible();
      await jumpToLatest.click();
      await page.setViewportSize({ width: 1280, height: 720 });
    }
  }

  await page.mouse.move(0, 0);
  const completedTurns = page.locator(
    '.conversation-turn[data-turn-status="completed"]',
  );
  await expect(completedTurns).toHaveCount(3);
  await expect(completedTurns.first().locator(".turn-fork-controls")).toHaveCSS(
    "opacity",
    "0",
  );
  await expect(completedTurns.last().locator(".turn-fork-controls")).toHaveCSS(
    "opacity",
    "1",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(scanner).toBeVisible();
  const [scannerBox, presentationBox] = await Promise.all([
    scanner.boundingBox(),
    page.getByTestId("thread-presentation-viewport").boundingBox(),
  ]);
  expect(scannerBox).not.toBeNull();
  expect(presentationBox).not.toBeNull();
  expect(
    Math.abs(
      scannerBox!.y +
        scannerBox!.height / 2 -
        (presentationBox!.y + presentationBox!.height / 2),
    ),
  ).toBeLessThanOrEqual(2);
  expect(
    presentationBox!.x +
      presentationBox!.width -
      (scannerBox!.x + scannerBox!.width),
  ).toBeLessThanOrEqual(30);

  const centerX = scannerBox!.x + scannerBox!.width / 2;
  const centerY = scannerBox!.y + scannerBox!.height / 2;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.waitForTimeout(280);
  const preview = page.locator(".mobile-chat-history-thumbstick-preview");
  await expect(preview).toContainText("Message 3 of 3");
  await expect(preview).toContainText("Newest mobile history checkpoint");
  const track = page.locator(".mobile-chat-history-thumbstick-track");
  const ticks = track.locator(".chat-history-tick");
  await expect(ticks).toHaveCount(3);
  await expect
    .poll(async () => (await track.boundingBox())?.height ?? 0)
    .toBeGreaterThan(84);
  const trackBox = await track.boundingBox();
  const tickBoxes = await ticks.evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { y: rect.y, height: rect.height };
    }),
  );
  expect(trackBox).not.toBeNull();
  expect(trackBox!.height).toBeLessThanOrEqual(90);
  expect(
    Math.abs(tickBoxes[0]!.y + tickBoxes[0]!.height / 2 - (trackBox!.y + 17)),
  ).toBeLessThanOrEqual(2);
  expect(
    Math.abs(
      tickBoxes[2]!.y +
        tickBoxes[2]!.height / 2 -
        (trackBox!.y + trackBox!.height - 17),
    ),
  ).toBeLessThanOrEqual(2);
  const tickSpacing =
    tickBoxes[1]!.y +
    tickBoxes[1]!.height / 2 -
    (tickBoxes[0]!.y + tickBoxes[0]!.height / 2);

  await page.mouse.move(centerX, centerY - tickSpacing - 6, { steps: 3 });
  await expect(preview).toContainText("Message 2 of 3");
  await expect(preview).toContainText("Latest mobile history checkpoint");
  await page.waitForTimeout(750);
  await expect(preview).toContainText("Message 2 of 3");

  await page.mouse.move(centerX, centerY - tickSpacing * 2 - 6, { steps: 3 });
  await expect(preview).toContainText("Message 1 of 3");
  await expect(preview).toContainText("Earlier mobile history checkpoint");
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "mobile-history-thumbstick-active.png");
  await page.mouse.up();

  await expect(preview).toBeHidden();
  await expect(
    page
      .locator('[data-item-kind="user_message"]')
      .filter({ hasText: "Earlier mobile history checkpoint" }),
  ).toBeInViewport();
  await capture(page, testInfo, "mobile-history-thumbstick-seek.png");

  await scanner.click();
  await expect(preview).toBeHidden();
  await expect(
    page
      .locator('[data-item-kind="user_message"]')
      .filter({ hasText: "Newest mobile history checkpoint" }),
  ).toBeInViewport();
});
