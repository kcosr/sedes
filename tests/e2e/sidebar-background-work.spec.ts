import { expect, test } from "./fixtures.js";
import { capture, openSedesWorkspace, selectCustomNewThreadTarget } from "./helpers.js";

test("sidebar prioritizes turns, unseen completion, subagents, and background commands", async ({ page }, testInfo) => {
  await openSedesWorkspace(page);
  await page.getByTestId("desktop-sidebar").getByTestId("new-thread-trigger").click();
  await page.getByRole("textbox", { name: "Thread name" }).fill("Background work priority");
  await selectCustomNewThreadTarget(page, "Claude subscription · Claude");
  const created = page.waitForResponse(response => response.request().method() === "POST"
    && response.url().endsWith("/api/threads") && response.status() === 201);
  await page.getByRole("button", { name: "Create thread" }).click();
  const { threadId } = await (await created).json() as { threadId: string };
  await expect(page).toHaveURL(new RegExp(`/threads/${threadId}$`));
  const row = page.getByTestId("desktop-sidebar").getByTestId("flat-thread-row")
    .filter({ has: page.getByText("Background work priority", { exact: true }) });
  const glyph = row.locator(".flat-row-glyph");
  const advance = async (stage: string) => {
    expect((await page.request.post(`/__e2e/claude/sidebar-background/${stage}`)).status()).toBe(204);
  };

  await page.getByRole("textbox", { name: /Message Claude/ }).fill("Start sidebar background fixture");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByTestId("background-activity-status")).toContainText("1 subagent, 1 command");
  await expect(glyph).toHaveAttribute("data-glyph", "running");
  await expect(glyph.locator(".comet-spinner")).toHaveCSS("animation-duration", "1s");
  await capture(page, testInfo, "sidebar-background-running.png");

  // Finish while away so the real attention service produces the completion dot.
  await page.goto("/");
  await expect(row).toBeVisible();
  await advance("finish");
  await expect(glyph).toHaveAttribute("data-glyph", "unseen");
  await expect(glyph.locator(".comet-spinner")).toHaveCount(0);
  await expect(glyph).toHaveAttribute("title", /1 subagent, 1 command/);
  await capture(page, testInfo, "sidebar-background-unseen.png");

  await advance("empty");
  await expect(glyph).toHaveAttribute("title", "Finished while you were away");
  await capture(page, testInfo, "sidebar-idle-unseen.png");
  await advance("agents");
  await expect(glyph).toHaveAttribute("title", /1 subagent, 1 command/);
  await row.getByTestId("thread-row-link").click();
  await expect(glyph).toHaveAttribute("data-glyph", "background-agents");
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await expect(glyph.locator(".comet-spinner")).toHaveCSS("animation-duration", "1.8s");
  await capture(page, testInfo, "sidebar-background-agents.png");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(glyph.locator(".comet-spinner")).toHaveCSS("animation-name", "none");
  await capture(page, testInfo, "sidebar-background-reduced-motion.png");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await advance("commands");
  await expect(glyph).toHaveAttribute("data-glyph", "background-commands");
  await expect(glyph).toHaveAttribute("title", "Background command running");
  await expect(glyph.locator(".flat-row-background-dot")).toHaveCSS("width", "6px");
  await expect(glyph.locator(".flat-row-background-dot")).toHaveCSS("height", "6px");
  await expect(glyph.locator(".comet-spinner")).toHaveCount(0);
  await capture(page, testInfo, "sidebar-background-commands.png");
  await advance("empty");
  await expect(glyph).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByTestId("background-activity-status")).toHaveCount(0);
});
