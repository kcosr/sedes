import type { Page, TestInfo } from "@playwright/test";
import { expect, type BrowserDiagnostics } from "./fixtures.js";
import {
  capture,
  openSedesWorkspace,
  selectCustomNewThreadTarget,
} from "./helpers.js";

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAkCAIAAAC2bqvFAAAACXBIWXMAAAABAAAAAQBPJcTWAAABGElEQVR4nO2ZMQ7CMAxFbakS3WDsysYx4WZcg42REbYymbRG0FCbGhB1G+XJQiJKYv/8JkBAUCCpEYkI5f5KM2gD1P54T2SpJ1Ao7VLK3qT/gxCN6awCxqyeMWr4wIFpYhIw/vIzFhOGBXhVzwxqSP0R8l1+5r0JSTswheVnggmgFJO0A7NAFTCd54dpd7JQUroOzIUswJsswJsswJsswJsswBtVgP1mZhzEb3KQggONrkoOOmB4rZdwgmdsKXob4gordQqowk+p1wFxlJdowK43xQLOTT/ci+Pn74B3Ab+SBXhTNNfxvB9iHodWCbDuHGHf/D/Am1HpXwMc2xDnb4/ycEisCDayACVvXITTZ0K+Xu8wvgnGdDe223I93IVcvAAAAABJRU5ErkJggg==",
  "base64",
);

export async function exerciseClaudeParityCoverage(
  input: {
    readonly page: Page;
    readonly browserDiagnostics: BrowserDiagnostics;
  },
  testInfo: TestInfo,
): Promise<void> {
  const { page, browserDiagnostics } = input;
  await openSedesWorkspace(page);

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
  await page
    .getByRole("textbox", { name: "Thread name" })
    .fill("Claude parity coverage");
  await selectCustomNewThreadTarget(page, "Claude subscription · Claude");
  await page.getByRole("button", { name: "Create thread" }).click();
  await created;
  await expect(page).toHaveURL(/\/threads\/[0-9a-f-]+$/);

  const threadPath = new URL(page.url()).pathname;
  const composer = page.getByTestId("composer");
  const uploaded = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "PUT" &&
      url.pathname.includes("/composer-attachments/") &&
      url.searchParams.get("fileName") === "claude-parity.png" &&
      response.ok()
    );
  });
  const attachmentLinked = page.waitForResponse((response) => {
    if (
      response.request().method() !== "PUT" ||
      !response.url().endsWith("/draft") ||
      !response.ok()
    ) {
      return false;
    }
    const body = response.request().postDataJSON() as {
      readonly attachmentIds?: readonly unknown[];
    };
    return body.attachmentIds?.length === 1;
  });
  // The local preview may race the first durable draft-owner link. This is an
  // expected retry path already covered by the common composer attachment job.
  browserDiagnostics.allowNetworkFailures = true;
  await composer.locator('input[type="file"]').setInputFiles({
    name: "claude-parity.png",
    mimeType: "image/png",
    buffer: tinyPng,
  });
  await uploaded;
  await attachmentLinked;
  browserDiagnostics.allowNetworkFailures = false;
  await expect(
    composer.getByLabel("Attachments").getByText("claude-parity.png"),
  ).toBeVisible();

  await composer
    .getByRole("textbox", { name: /Message Claude/ })
    .fill("CLAUDE_PARITY_NATIVE_IMAGE: inspect this PNG with semantic tools.");
  const accepted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/operations") &&
      response.ok(),
  );
  await page.getByRole("button", { name: "Send message" }).click();
  await accepted;

  const activity = page.getByRole("button", {
    name: /Activity · 4 tool calls/,
  });
  await expect(activity).toBeVisible();
  await activity.click();
  await expect(
    page.locator('[data-item-kind="command"][data-item-status="streaming"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-item-kind="file_read"][data-item-status="streaming"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-item-kind="web_search"][data-item-status="streaming"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-item-kind="mcp"][data-item-status="streaming"]'),
  ).toBeVisible();
  await expect(
    page.locator(
      '[data-item-kind="collaboration"][data-item-status="streaming"]',
    ),
  ).toBeVisible();
  await capture(page, testInfo, "claude-parity-streaming-tools.png");

  const finalText =
    "Claude received the native PNG and completed semantic tool parity.";
  await expect(page.getByText(finalText, { exact: true })).toBeVisible();
  for (const kind of [
    "command",
    "file_read",
    "web_search",
    "mcp",
    "collaboration",
  ]) {
    await expect(
      page.locator(`[data-item-kind="${kind}"][data-item-status="completed"]`),
    ).toBeVisible();
  }
  await expect(
    page.getByText("claude-parity.png", { exact: true }),
  ).toBeVisible();
  await capture(page, testInfo, "claude-parity-settled.png");

  await page.reload();
  await expect(page).toHaveURL(threadPath);
  await expect(page.getByText(finalText, { exact: true })).toBeVisible();
  const restoredActivity = page.getByRole("button", {
    name: /Activity · 4 tool calls/,
  });
  await expect(restoredActivity).toBeVisible();
  await restoredActivity.click();
  await expect(
    page.locator('[data-item-kind="command"][data-item-status="completed"]'),
  ).toBeVisible();
  await expect(
    page.locator(
      '[data-item-kind="collaboration"][data-item-status="completed"]',
    ),
  ).toBeVisible();
  await expect(
    page.getByText("claude-parity.png", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Choose skill" }).click();
  const skillPicker = page.getByRole("dialog", { name: "Choose a skill" });
  await expect(skillPicker.getByText("review", { exact: true })).toBeVisible();
  await skillPicker.getByText("review", { exact: true }).click();
  await expect(page.getByTestId("selected-skill")).toContainText("review");
  await composer
    .getByRole("textbox", { name: /Message Claude/ })
    .fill("the semantic fixture");
  const skillAccepted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/operations") &&
      response.ok(),
  );
  await page.getByRole("button", { name: "Send message" }).click();
  await skillAccepted;
  const skillAnswer =
    "Claude completed the selected review skill as an ordinary model turn.";
  await expect(page.getByText(skillAnswer, { exact: true })).toBeVisible();
  await expect(
    page
      .locator('[data-item-kind="user_message"]')
      .last()
      .getByText("review", { exact: true }),
  ).toBeVisible();
  await capture(page, testInfo, "claude-parity-skill.png");

  await page.reload();
  await expect(page).toHaveURL(threadPath);
  await expect(page.getByText(skillAnswer, { exact: true })).toBeVisible();
  await expect(
    page
      .locator('[data-item-kind="user_message"]')
      .last()
      .getByText("review", { exact: true }),
  ).toBeVisible();
}
