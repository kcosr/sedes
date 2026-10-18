import { test, expect } from "./fixtures";
import {
  capture, createDraftThread, expectNoPageOverflow, fillAndPersistDraft,
  openSedesWorkspace, sendCurrentDraft,
} from "./helpers";

test("runtime notices deduplicate and dismiss across clients, then admit a new occurrence", async ({ page, browser }, testInfo) => {
  await openSedesWorkspace(page);
  const threadPath = await createDraftThread(page, "Runtime notices");
  const threadId = threadPath.split("/").at(-1)!;
  // Separate clients need independent connection pools: two pages in one
  // context can exhaust Chromium's HTTP/1.1 sockets with SSE and long polls.
  const observerContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const observer = await observerContext.newPage();
    await observer.goto(threadPath);
    await expect(observer.getByRole("textbox", { name: "Message Scripted agent" })).toBeVisible();
    const message = "Claude usage is approaching its current limit.";
    const publish = async (tone: "warning" | "error", text = message) => {
      const response = await page.request.post(`/__e2e/threads/${threadId}/notices`, {
        data: { tone, message: { text } },
      });
      expect(response.ok(), await response.text()).toBe(true);
      return await response.json() as { eventId: string; notices: Array<{ id: string; createdAt: string; tone: string }> };
    };
    const warning = (target: typeof page) => target.locator(".runtime-notice.warning").filter({ hasText: message });
    const first = await publish("warning");
    await expect(warning(page)).toHaveCount(1);
    await expect(warning(observer)).toHaveCount(1);
    for (let repeat = 0; repeat < 3; repeat += 1) {
      // Neither retained identity/timestamp nor stream watermark changes.
      expect(await publish("warning")).toEqual(first);
    }
    await publish("error");
    await expect(page.locator(".runtime-notice.error").filter({ hasText: message })).toHaveCount(1);
    const dismissed = page.waitForResponse(response => response.request().method() === "POST" &&
      response.url().endsWith(`/api/threads/${threadId}/notices/dismiss`));
    await warning(page).getByRole("button", { name: "Dismiss", exact: true }).click();
    expect((await dismissed).status()).toBe(204);
    await expect(warning(page)).toHaveCount(0);
    await expect(warning(observer)).toHaveCount(0);
    await expect(page.locator(".runtime-notice.error").filter({ hasText: message })).toHaveCount(1);
    await observer.reload();
    await expect(observer.getByRole("textbox", { name: "Message Scripted agent" })).toBeVisible();
    await expect(observer.locator(".runtime-notice.error").filter({ hasText: message })).toHaveCount(1);
    await expect(warning(observer)).toHaveCount(0);

    const next = await publish("warning");
    expect(next.notices.find(notice => notice.tone === "warning")?.id).not.toBe(first.notices[0]!.id);
    await expect(warning(page)).toHaveCount(1);
    await expect(warning(observer)).toHaveCount(1);
    await publish("warning", 'MCP server "node_repl" failed to start. Its tools are unavailable. Check the MCP configuration on the execution host.');
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "runtime-notices-mobile.png");

    expect((await page.request.post("/__e2e/pi/turn-response/arm")).status()).toBe(204);
    try {
      await fillAndPersistDraft(page, "Continue while the warning is visible");
      await sendCurrentDraft(page);
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
      // First Send binds the draft to a new runtime generation, clearing the
      // draft's transient notices. Exercise a fresh notice during the live turn.
      await expect(warning(page)).toHaveCount(0);
      await publish("warning");
      await expect(warning(page)).toHaveCount(1);
      await expect(warning(observer)).toHaveCount(1);
      await capture(page, testInfo, "runtime-notices-streaming-mobile.png");
      const activeDismissal = page.waitForResponse(response => response.request().method() === "POST" &&
        response.url().endsWith(`/api/threads/${threadId}/notices/dismiss`));
      await warning(page).getByRole("button", { name: "Dismiss", exact: true }).click();
      expect((await activeDismissal).status()).toBe(204);
      await expect(warning(page)).toHaveCount(0);
      await expect(warning(observer)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    } finally {
      expect((await page.request.post("/__e2e/pi/turn-response/release")).status()).toBe(204);
    }
    // The scripted response completes at 13 × 800 ms after release.
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden({ timeout: 20_000 });
  } finally {
    await observerContext.close();
  }
});
